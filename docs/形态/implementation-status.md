# Loop Graph SDK 实现形态

> 2026-07-09 | 单 agent MVP 阶段 (v0.1.0)
>
> 上次更新：反馈根因修复计划（阶段 1-4）全部落地

---

## 一、文件结构

```
src/
├── type.ts                 # 核心类型（Graph, Node, Edge, Router, AgentInstance, …）
├── runtime.ts              # GraphRuntime（调用栈 + 帧栈 + 哨兵）
├── validate.ts             # 图校验 + 工具校验（validateGraphTools）
├── router.ts               # 单边裁决
├── tools-resolve.ts        # ★ 工具解析单一真相源（resolveNodeTools：去重 + 排序）
├── agent-execute.ts        # createAgentExecute 工厂（tools 参数已废弃）
├── registry.ts             # GraphRegistry 实例级图注册表（+ deprecated 全局兼容层）
├── index.ts                # 对外导出（library API + deprecated 兼容层）
├── adapter/
│   ├── loop-graph-extension.ts  # ★ 可实例化运行时工厂 createLoopGraphExtension()
│   ├── extension.ts             # debug/demo extension 入口（可选，{ demoGraphs: true }）
│   ├── projection.ts            # 纯函数：三段重组消息
│   ├── projection.test.ts       # 投影测试
│   ├── pi-node-context.ts       # Promise 桥接：runAgent + after_provider_response 错误回流
│   ├── complete-tool.ts         # __graph_complete__ 工具定义
│   ├── debug-log.ts             # 调试日志（现在读 getActiveTools() 真值）
│   ├── loop-graph-extension.test.ts  # 工厂 + 实例隔离 + 子图 agent + 工具校验
├── graphs/
│   ├── review-graph.ts     # echo 测试图
│   ├── probe-graph.ts      # 哨兵可见性验证图
│   ├── chain-graph.ts      # 双节点链式验证图
│   ├── subgraph-graph.ts   # 子图隔离验证图
│   └── validate-graph.ts   # 完成度验证测试图
├── tools-resolve.test.ts   # ★ resolveNodeTools 单元测试（14 条）
├── registry.test.ts        # GraphRegistry parseArgs + 闭包绑定测试
├── runtime.test.ts         # GraphRuntime 单元测试
├── router.test.ts          # 路由策略单元测试
├── validate.test.ts        # 图校验 + 工具校验单元测试（15 条）
└── docs-consistency.test.ts # 文档一致性检查
```

---

## 二、核心机制

### 2.1 哨兵消息

**目的**：在 pi 的 messages 数组中标记"当前节点开始"的切分点。

**实现**：

- `GraphRuntime.nextMarker(nodeId)` 生成唯一标记：`__node_boundary__:{nodeId}:{递增计数}:{随机8字符}`
- 随机后缀保证跨调用不重复
- 进节点前通过 `pi.sendMessage({ customType: "loop_graph_boundary", content: marker, display: false })` 注入
- 同一节点重复进入（循环边）也能区分

### 2.2 context 投影（三段重组）

**目的**：每次 LLM 调用前动态重组消息，使 agent 只看到帧栈摘要 + 当前节点工作区，前序节点的 ReAct 被丢弃。

**哨兵切分**：

```
messages 中的布局：
[sys, user, S1, 节点A的ReAct..., S2, 节点B的prompt, 节点B的工作...]

投影找两个位置：
  firstIdx = 第一个哨兵（S1）                  ← 图的 entry 边界
  currentIdx = 当前节点的哨兵（S2 / nodeMarker）← 当前节点的起点
```

**三段产出**：

```
head = before firstIdx                          → [sys, user]（图之外的信息）
active = after currentIdx                       → [prompt, 节点B的工作...]
S1 ~ S2 之间的原始 ReAct 被丢弃，由帧段替换
```

投影输出结构不变，见原文档。

### 2.3 完成度验证

节点可声明 `validateCompletion`，agent 调用 `__graph_complete__` 时检查 result：

```
agent → __graph_complete__({ status: "ok", result: { question: "...", answer: "..." } })
  ↓ validateCompletion: 检查必填字段
  ↓ 不通过 → inject "验证未通过: 缺少..." → triggerTurn → agent 继续
  ↓ agent 补全 → 再次 __graph_complete__
  ↓ 通过 → resolve Promise → 进入下一节点
```

### 2.4 createAgentExecute 工厂

```typescript
const myNode: Node = {
  kind: "code",
  id: "grade",
  subGoal: "批改答案",
  execute: createAgentExecute({ skill: "review-grade" }),
  validateCompletion: requireFields(["score", "explanation"]),
};
```

**注意**：`tools` 参数已废弃。工具集统一由 `Node.tools` 声明，经 `resolveNodeTools` 合并 `defaultTools` 并去重。

### 2.5 Promise 桥接 + 错误回流（runAgent）

**实现**（`pi-node-context.ts`）：

1. `runAgent()` 创建 Promise，存 `resolve` 到 `this.activeResolve`
2. `pi.sendMessage(prompt, { triggerTurn: true })` 触发 agent 运行
3. `agent_end` → `onAgentEnd()` → 检查验证 → resolve
4. 超时保护：5 分钟自动 resolve 为 `status: "failed"`
5. **Provider 错误回流**：构造函数单一监听 `after_provider_response`，`status >= 400 && !== 429` 时立即 resolve 为 `failed`（不等待超时，不误杀限流）
6. **死图防御**：`activeRunId === 0` 时 `onAgentEnd` 追加终止消息，不再静默丢弃

### 2.6 可实例化运行时工厂（★ 核心）

每个 `createLoopGraphExtension(pi, options?)` 返回独立 `LoopGraphExtension`：

```typescript
export function createLoopGraphExtension(pi, options?) {
  let activeRuntime = null;    // 实例级，不再模块全局
  let activeNodeContext = null;
  const defaultTools = options.defaultTools ?? [];
  const skillBasePath = options.skillBasePath ?? path.join(process.cwd(), "skills");
  const registry = new GraphRegistry(pi, executeGraph);
  
  return {
    registerGraph: (graph) => registry.registerGraph(graph, defaultTools),
    executeGraph: (graph, trigger) => executeGraph(pi, graph, trigger),
  };
}
```

**关键变更**：

- `activeRuntime`/`activeNodeContext` 从模块级单例 → 工厂闭包内的实例变量
- 子图执行时切换 `activeRuntime`/`activeNodeContext`（push/pop 模式）
- `GraphRegistry` 为实例级 class，业务 extension 间不互相污染
- `__graph_complete__` 用 `WeakSet` 去重，同 pi 多实例不重复注册
- `LoopGraphExtensionOptions` 新增 `skillBasePath`、`defaultTools` 参数

### 2.7 工具解析单一真相源

全仓库只有 `resolveNodeTools(defaultTools, nodeTools)` 产出最终工具列表。`setActiveTools` 调它，debug 日志也调它（通过 `pi.getActiveTools()` 读真值）。

**契约**：

- 去重（保留首次出现位置）
- `read` 强制首位
- `__graph_complete__` 强制末位
- 顺序稳定，相同输入总产出相同结果

### 2.8 注册期 + 首次执行工具校验

- **注册期**（`GraphRegistry.registerGraph`）：节点内 `tools` 数组重复名 → 立即抛错（`DUPLICATE_TOOL_IN_NODE`）
- **首次执行**（`executeGraph`）：遍历 `defaultTools ∪ node.tools`，用 `pi.getAllTools()` 检查未注册工具 → 抛错（`TOOL_NOT_REGISTERED`），缓存 per-graph

### 2.9 skill 原生集成

- `resources_discover` 事件注册 `skillBasePath`，pi 原生 skill 系统发现 SKILL.md
- 进入节点时（哨兵之后），读取 `{skillBasePath}/{node.skill}/SKILL.md` 内容，通过 `sendMessage({ display: false })` 追加到消息流（不触发额外 turn）
- 文件不存在时日志警告但不阻塞
- `skill:` 行在 projection CURRENT 段仅保留名称，完整内容由运行时追加
- `type.ts` 注释已诚实化

### 2.10 图异常终止信号回流

`executeGraph` catch 块捕获异常时，通过 `sendUserMessage` 向 agent 注入可见的终止信号：

```
[系统] 图 "xxx" 因错误意外终止：{reason}。当前节点已失效，请停止推理。
```

---

## 三、上下文隔离契约

### 顶层图

同前设计。`AgentInstance` 不继承图之外的完整上下文。`background` 只有 trigger 入参。

### 子图（★ 修复）

子图执行时正确切换工厂级 `activeRuntime`/`activeNodeContext`：

```
execNode 检测到 kind: "graph"
  ↓
runSubgraphInExtension 创建 childRuntime：
  prevRt = activeRuntime; prevNc = activeNodeContext
  activeRuntime = childRt; activeNodeContext = childNc
  ↓ 执行子图主线
  ↓ finally: activeRuntime = prevRt; activeNodeContext = prevNc
```

这确保了子图内的 agent 节点调用 `__graph_complete__` 时，完成信号被正确的 `PiNodeContext`（子图的）捕获，而非父图的。

---

## 四、已验证清单

| 验证项                                     | 方式                                                    | 结果 |
| ------------------------------------------ | ------------------------------------------------------- | ---- |
| 命令 handler 内 await agent turn           | `/probe`                                              | ✅   |
| 哨兵消息进入 context 数组                  | 探针日志                                                | ✅   |
| 哨兵跨调用唯一                             | debug log                                               | ✅   |
| 双节点链式推进                             | `/chain`                                              | ✅   |
| 帧栈折叠（前序 ReAct 被丢弃）              | debug log projection                                    | ✅   |
| 子图 push/pop + 隔离                       | `/sub` + debug log                                    | ✅   |
| 图校验                                     | `assertValidGraph` 编译期                             | ✅   |
| 路由独立模块                               | `router.ts`                                           | ✅   |
| 完成度验证                                 | `/validate-test`                                      | ✅   |
| 日志层                                     | `loop-graph-debug.log`                                | ✅   |
| 工厂实例隔离                               | `loop-graph-extension.test.ts`                        | ✅   |
| 子图 agent 节点完成                        | `loop-graph-extension.test.ts`                        | ✅   |
| parseArgs 命令入口                         | `registry.test.ts`                                    | ✅   |
| tool execute 闭包绑定                      | `registry.test.ts`                                    | ✅   |
| demo graphs 门控                           | `loop-graph-extension.test.ts`                        | ✅   |
| defaultTools 合并                          | `loop-graph-extension.test.ts`                        | ✅   |
| 多实例`__graph_complete__` 幂等          | `loop-graph-extension.test.ts`                        | ✅   |
| **resolveNodeTools 去重 + 排序**     | `tools-resolve.test.ts`（14 条）                      | ✅   |
| **注册期节点内工具重复检测**         | `validate.test.ts` + `loop-graph-extension.test.ts` | ✅   |
| **首次执行未注册工具检测**           | `loop-graph-extension.test.ts`                        | ✅   |
| **skill 追加不触发额外 turn**        | 代码审查 +`sendMessage`（无 triggerTurn）             | ✅   |
| **after_provider_response 错误回流** | 代码审查（构造函数单一监听）                            | ✅   |
| **图终止信号注入 agent**             | 代码审查（`executeGraph` catch）                      | ✅   |
| **input 不进 agent 上下文**          | projection 删 input 渲染 + 显式 prompt                  | ✅   |
| **mechanism 运行时分派 + scratch**   | `loop-graph-extension.test.ts`（4 条）                | ✅   |
| **全局机制（Graph.mechanisms）接线** | `loop-graph-extension.test.ts`                        | ✅   |

---

## 五、已知缺口

| 缺口                         | 说明                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `agent-choice` 路由        | `throw Error` 占位；短期用 `custom`;                                                     |
| `pi-node-context.callTool` | `throw Error` 占位                                                                         |
| schema helper                | `NodeCompletion.result` 等保持 `Record<string, unknown>`；下一阶段补 runtime schema 校验 |
| 失败边处理                   | `selectEdge` 返回 null 时优雅结束（不 throw），可通过 edge guard 语义覆盖                  |
| 帧栈太长触发 compaction      | 不处理（投影天然免疫，框架不干预）                                                           |
| session 续跑                 | 帧栈未持久化到磁盘                                                                           |

### 已关闭的缺口

| 缺口                                            | 说明                                                                                                        | 关闭版本        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------- |
| 多 skill                                        | 当前单`node.skill?: string`；已通过 `resources_discover` + 运行时追加实现原生 skill 集成                | v0.1.0+stage3   |
| defaultTools 流入 skill 节点                    | 证实为观测造假（debug log 未包含 defaultTools）。`resolveNodeTools` + `getActiveTools()` 真值日志已修复 | v0.1.0+stage1   |
| `createAgentExecute(options).tools` 误导      | 已 deprecated，不消费                                                                                       | v0.1.0+stage1   |
| `defaultTools` + `node.tools` 无去重 → 400 | `resolveNodeTools` name-based dedup + 注册期校验                                                          | v0.1.0+stage1/2 |
| 注册期无校验                                    | `validateGraphTools` 注册期 dup 检查 + 首次执行 existence 检查                                            | v0.1.0+stage2   |
| 400 后僵尸状态                                  | `after_provider_response` 错误回流 + 图终止信号 `sendUserMessage`                                       | v0.1.0+stage4   |

---

## 六、后续

- `agent-choice` 路由实现（或标记 stable-unsupported）
- `pi-node-context.callTool` 实现（等待 pi API 确认）
- schema helper 工具函数
- Pi Review Agent `/review-turn` 验证
- 正式发布前移除 debug log 文件输出
