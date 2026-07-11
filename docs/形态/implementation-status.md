# Loop Graph SDK 实现形态

> 2026-07-11 | NodeScope v2 / 独立子会话重构阶段
>
> 上次更新：GraphExecutionHost 基础切片与 NodeScope v2 Phase 4 落地

## 2026-07-11 重构状态

- 图执行返回统一为 `GraphRunResult`；runtime-only 子 adapter 复用真实 `createLoopGraphExtension`，不再维护第二套弱化 Runtime，也不直接改写 `session.agent.state.messages`。
- `GraphRuntime` 使用结构化 `NodeScopeDescriptor`（graphRunId / instanceId / scopeId / graphId / nodeId / visit / depth），主路径已删除随机 `loop_graph_boundary` 哨兵。
- projection 从尾部匹配当前 `scopeId`，输出 frames + 当前 NodeScope 后的 live ReAct；外层 transcript、旧节点 ReAct、scope 前 compaction summary 均不保留。
- scope 缺失时 fail closed：只恢复 frames + 确定性 CURRENT，不回退 raw transcript。
- 图节点活跃期间收到 pi `session_compact` 后，会同步重发同一 `scopeId` 的 NodeScope checkpoint；overflow retry 因此从新 checkpoint 开始，`compactionGeneration` / `reason` / `willRetry` 写入 debug trace。
- 子图普通结果只暴露最终 result，不再把 child frames 泄漏给父图。
- 验证：`tsc --noEmit` 通过；全量 12 个测试文件、155 项测试通过（含真实 LLM Phase 0）。

> 下文部分历史章节仍记录 MVP 演进背景；当前实现以本节和 NodeScope v2 文档为准。

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

### 2.11 mechanism 运行时

Runtime 在节点进入后、`execute` 之前自动分派 onNodeEnter：

```
enterNode → Graph.mechanisms.onNodeEnter → Node.mechanisms.onNodeEnter → execute
```

- `Graph.mechanisms` 在 `pushGraph` 时写入 `AgentInstance.mechanisms`，跨节点持续生效。
- `Node.mechanisms` 只在当前节点叠加。
- 每个 mechanism 若定义了 `onNodeEnter`，串行 `await onNodeEnter(ctx)`。
- `onNodeEnter` 抛错统一记 debug log 后继续，不中止节点。

`MechanismContext` 提供 pi 全部能力 + 两个显式作用通道：

| 成员 | 用途 |
|------|------|
| `ctx.pi` | 全部 pi 能力：注册 `tool_result`、`turn_start`、`before_provider_request` 等原生事件；改工具集；发消息 |
| `ctx.instance` | 当前 AgentInstance（可写 `instance.scratch`） |
| `ctx.node` | 当前节点 |
| `ctx.input` | 代码侧一次性入参 |
| `ctx.appendContext(content)` | 向 agent 消息流追加（`sendMessage({ customType: "loop_graph_mechanism", display: false })`），不触发额外 turn，落点在本节点 active 段 |

onNodeEnter 是注册钩子的入口——机制在里面用 `ctx.pi.on()` 注册 pi 原生事件，这些事件在 agent 运行期间持续触发。pi 没有 off，回调需自限条件。

### 2.12 agent-choice 路由

agent-choice 路由允许 agent 在 completion 中声明 `chosen_edge_id`，router 据此选择边。

```typescript
completion.result.chosen_edge_id = "to_discuss";  // agent 自主决策走哪条边
```

**设计要点**：
- **不调 LLM**：router 只是从 `completion.result` 读字段，不做任何推理（编排不推理）
- **CURRENT 段渲染**：projection 在 agent-choice 节点的 CURRENT 段追加 `availableEdges` 列表，含每条边的 `id`、`description`、`priority`、`target`
- **description 必填**：agent-choice 路由下每条边必须有非空 `description`，`validateGraph` 注册期校验（`AGENT_CHOICE_EDGE_MISSING_DESCRIPTION`）
- **驳回重试**：agent 未声明 `chosen_edge_id` 或声明了不存在的边 → 利用 `validateCompletion` 驳回机制，reason 中列出所有可选边及描述，触发 agent 重试
- **降级安全网**：`selectEdge` 在 agent-choice 下仍做 priority-first fallback（防御性，正常路径被 validator 拦截）
- **单边优化**：只有一条边匹配 guard 时直接返回，不等 agent 声明

**校验注入机制**：

`executeGraph` / `runSubgraphInExtension` 在调用 `execNodeInGraph` 前检测路由策略，若为 agent-choice 则通过 `wrapWithAgentChoiceValidator` 将节点包装：

```typescript
// 伪代码
const effectiveNode = wrapWithAgentChoiceValidator(graph, nodeId, node);
// effectiveNode.validateCompletion 已合成 agent-choice 边选择校验
```

`createAgentChoiceValidator` 产出的校验器：
1. 先跑节点自身的 `validateCompletion`（如有）
2. 检查 `result.chosen_edge_id` 非空且匹配已知边 ID
3. 失败时 reason 列出所有可选边：`  • to_archive (priority: 10) → archive_node\n    答对，归档结果`

**Edge 扩展**：
```typescript
export interface Edge {
  // ... 原有字段 ...
  /** 边的可读描述。agent-choice 路由下必填，渲染给 agent 辅助决策。 */
  description?: string;
}
```

**ProjectionInput 扩展**：
```typescript
availableEdges?: Array<{ id: string; description: string; priority: number; target: string }>;
```

`agentChoiceField` 允许自定义字段名（默认 `"chosen_edge_id"`）。

### 2.13 隔离图执行载体契约（基础切片）

已新增公开的图执行边界类型：

- `GraphRunRequest`：只通过 `background` 携带显式调用输入，并标注 tool/command/subgraph 来源。
- `GraphRunResult`：统一返回 graphId、业务终态、END 最终 result 和步数；不包含 frames/trace。
- `GraphExecutionHost`：图执行载体抽象。
- `IsolatedSessionGraphHost`：独立子 AgentSession 的生命周期外壳。

当前 `IsolatedSessionGraphHost` 已固化以下行为：同一 host 禁止并发 run；outer AbortSignal 转发到子会话；清理顺序固定为 abort → dispose；dispose 幂等；dispose 后拒绝再次运行。子 AgentSession 的实际创建与 runtime-only graph adapter 绑定通过 `IsolatedGraphSessionFactory` 注入，尚未切换 `GraphRegistry` 的 graph tool 路径。

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
| **mechanism 运行时分派 + scratch**   | `loop-graph-extension.test.ts`                        | ✅   |
| **mechanism appendContext 追加上下文** | `loop-graph-extension.test.ts`                        | ✅   |
| **自定义帧格式 frameFormatter** | `projection.test.ts`                        | ✅   |
| **agent-choice 路由** | `router.test.ts` + `validate.test.ts` + `projection.test.ts` | ✅ |
| **Phase 0 独立 AgentSession 可行性** | `graph-execution-host.spike.test.ts`（29 条，含真实 LLM） | ✅ |
| **Phase 1 现有行为冻结** | `characterization.test.ts`（11 条） | ✅ |
| **GraphExecutionHost 生命周期契约** | `graph-execution-host.test.ts`（8 条） | ✅ |

---

## 五、已知缺口

| 缺口                         | 说明                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `pi-node-context.callTool` | `throw Error` 占位                                                                         |
| schema helper                | `NodeCompletion.result` 等保持 `Record<string, unknown>`；下一阶段补 runtime schema 校验 |
| 失败边处理                   | `selectEdge` 返回 null 时优雅结束（不 throw），可通过 edge guard 语义覆盖                  |
| 自定义 compaction 策略      | 不实现；SDK 不生成 LLM summary、不主动调用 compact，继续使用 pi 原生策略 |
| session 续跑                 | 帧栈未持久化到磁盘                                                                           |
| graph tool 切换独立 host     | Host 类型与生命周期已实现；尚需 runtime-only 子 adapter、GraphRunResult 主循环返回与 Registry 接线 |
| 三类图调用边界               | Phase 6 类型与校验已完成；当前仅 `call` 语义可执行，compose/delegate graph-node 会明确拒绝，等待 Phase 8/10 接线 |

### 已关闭的缺口

| 缺口                                            | 说明                                                                                                        | 关闭版本        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------- |
| 多 skill                                        | 当前单`node.skill?: string`；已通过 `resources_discover` + 运行时追加实现原生 skill 集成                | v0.1.0+stage3   |
| defaultTools 流入 skill 节点                    | 证实为观测造假（debug log 未包含 defaultTools）。`resolveNodeTools` + `getActiveTools()` 真值日志已修复 | v0.1.0+stage1   |
| `createAgentExecute(options).tools` 误导      | 已 deprecated，不消费                                                                                       | v0.1.0+stage1   |
| `defaultTools` + `node.tools` 无去重 → 400 | `resolveNodeTools` name-based dedup + 注册期校验                                                          | v0.1.0+stage1/2 |
| 注册期无校验                                    | `validateGraphTools` 注册期 dup 检查 + 首次执行 existence 检查                                            | v0.1.0+stage2   |
| `agent-choice` 路由未实现 | agent 通过 `completion.result.chosen_edge_id` 声明边选择；CURRENT 段渲染 `availableEdges`；`description` 注册期必填校验 | v0.1.0+stage5 |
| COMPLETED 段硬编码 JSON 格式 | `frameFormatter` 选项让开发者完全自定义帧折叠后的上下文内容与格式 | v0.1.0+stage6 |

---

## 六、后续

- `pi-node-context.callTool` 实现（等待 pi API 确认）
- schema helper 工具函数
- Pi Review Agent `/review-turn` 验证
- 正式发布前移除 debug log 文件输出
