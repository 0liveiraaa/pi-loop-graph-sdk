# Loop Graph SDK 实现形态

> 2026-07-08 | 单 agent MVP 阶段 (v0.1.0)
>
> 上次更新：library boundary 演进完成（`createLoopGraphExtension` 工厂 + 实例级 Registry）

---

## 一、文件结构

```
src/
├── type.ts                 # 核心类型（Graph, Node, Edge, Router, AgentInstance, …）
├── runtime.ts              # GraphRuntime（调用栈 + 帧栈 + 哨兵）
├── validate.ts             # 图校验
├── registry.ts             # GraphRegistry 实例级图注册表（+ deprecated 全局兼容层）
├── router.ts               # 单边裁决
├── agent-execute.ts        # createAgentExecute 工厂
├── adapter/
│   ├── loop-graph-extension.ts  # ★ 可实例化运行时工厂 createLoopGraphExtension()
│   ├── extension.ts             # debug/demo extension 入口（可选，{ demoGraphs: true }）
│   ├── projection.ts            # 纯函数：三段重组消息
│   ├── projection.test.ts       # 投影测试
│   ├── pi-node-context.ts       # Promise 桥接：runAgent / callTool + 完成度验证
│   ├── complete-tool.ts         # __graph_complete__ 工具定义
│   ├── debug-log.ts             # 调试日志
│   └── loop-graph-extension.test.ts  # 工厂 + 实例隔离 + 子图 agent 测试
├── registry.test.ts       # GraphRegistry parseArgs + 闭包绑定测试
├── graphs/
│   ├── review-graph.ts     # echo 测试图
│   ├── probe-graph.ts      # 哨兵可见性验证图
│   ├── chain-graph.ts      # 双节点链式验证图
│   ├── subgraph-graph.ts   # 子图隔离验证图
│   └── validate-graph.ts   # 完成度验证测试图
└── index.ts                # 对外导出（library API + deprecated 兼容层）
```

### 包入口结构

```json
{
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",                     // Library API
    "./extension": "./src/adapter/extension.ts"  // Debug/demo extension
  }
}
```

- `"."` → library API：`createLoopGraphExtension`、`createAgentExecute`、types、runtime、validation
- `"./extension"` → 可选 debug extension，只注册 demo graphs 和基础钩子

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

替代 `execute: null as any` + `skill: "__probe__"`：

```typescript
const myNode: Node = {
  kind: "code",
  id: "grade",
  subGoal: "批改答案",
  execute: createAgentExecute({ skill: "review-grade", tools: ["review_answer"] }),
  validateCompletion: requireFields(["score", "explanation"]),
};
```

`execNode` 对所有 code 节点一律调 `node.execute()`，不再用 `skill`/`tools` 做启发式判断。

### 2.5 Promise 桥接（runAgent）

**实现**（`pi-node-context.ts`）：

1. `runAgent()` 创建 Promise，存 `resolve` 到 `this.activeResolve`
2. `pi.sendMessage(prompt, { triggerTurn: true })` 触发 agent 运行
3. `agent_end` → `onAgentEnd()` → 检查验证 → resolve
4. 超时保护：5 分钟自动 resolve 为 `status: "failed"`

### 2.6 可实例化运行时工厂（★ 新增）

**替代原模块级单例**。每个 `createLoopGraphExtension(pi, options?)` 返回独立 `LoopGraphExtension`：

```typescript
export function createLoopGraphExtension(pi, options?) {
  let activeRuntime = null;    // 实例级，不再模块全局
  let activeNodeContext = null;
  const registry = new GraphRegistry(pi, executeGraph);

  // 注册钩子（引用实例级 activeRuntime/activeNodeContext）
  // 注册 __graph_complete__（WeakSet per-pi 幂等）
  // 注册 demo graphs（仅当 options.demoGraphs）

  return {
    registerGraph: (graph) => registry.registerGraph(graph),
    executeGraph: (graph, trigger) => executeGraph(pi, graph, trigger),
  };
}
```

**关键变更**：
- `activeRuntime`/`activeNodeContext` 从模块级单例 → 工厂闭包内的实例变量
- 子图执行时切换 `activeRuntime`/`activeNodeContext`（push/pop 模式）
- `GraphRegistry` 为实例级 class，业务 extension 间不互相污染
- `__graph_complete__` 用 `WeakSet` 去重，同 pi 多实例不重复注册

### 2.7 调用栈（GraphRuntime）

同前，`GraphRuntime.callStack` 支持子图 push/pop。

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

| 验证项 | 方式 | 结果 |
|--------|------|------|
| 命令 handler 内 await agent turn | `/probe` | ✅ |
| 哨兵消息进入 context 数组 | 探针日志 | ✅ |
| 哨兵跨调用唯一 | debug log | ✅ |
| 双节点链式推进 | `/chain` | ✅ |
| 帧栈折叠（前序 ReAct 被丢弃） | debug log projection | ✅ |
| 子图 push/pop + 隔离 | `/sub` + debug log | ✅ |
| 图校验 | `assertValidGraph` 编译期 | ✅ |
| 路由独立模块 | `router.ts` | ✅ |
| 完成度验证 | `/validate-test` | ✅ |
| 日志层 | `loop-graph-debug.log` | ✅ |
| 工厂实例隔离 | `loop-graph-extension.test.ts` | ✅ |
| 子图 agent 节点完成 | `loop-graph-extension.test.ts` | ✅ |
| parseArgs 命令入口 | `registry.test.ts` | ✅ |
| tool execute 闭包绑定 | `registry.test.ts` | ✅ |
| demo graphs 门控 | `loop-graph-extension.test.ts` | ✅ |
| defaultTools 合并 | `loop-graph-extension.test.ts` | ✅ |
| 多实例 `__graph_complete__` 幂等 | `loop-graph-extension.test.ts` | ✅ |

---

## 五、已知缺口

| 缺口 | 说明 |
|------|------|
| `agent-choice` 路由 | `throw Error` 占位；标记为 experimental，短期用 `custom` |
| `pi-node-context.callTool` | `throw Error` 占位；等待 pi stable extension-side tool API |
| 多 skill | 当前单 `node.skill?: string`；下一阶段 `graph.skills + node.skills` |
| schema helper | `NodeCompletion.result` 等保持 `Record<string, unknown>`；下一阶段先补 runtime schema 校验 |
| 失败边处理 | `selectEdge` 返回 null 时优雅结束（不 throw），可通过 edge guard 语义覆盖 |
| 帧栈太长触发 compaction | 不处理（投影天然免疫，框架不干预） |
| session 续跑 | 帧栈未持久化到磁盘 |

---

## 六、后续

- `agent-choice` 路由实现（或标记 stable-unsupported）
- `pi-node-context.callTool` 实现（等待 pi API 确认）
- 多 skill 支持
- schema helper 工具函数
- Pi Review Agent `/review-turn` 验证
- 正式发布前移除 debug log 文件输出
