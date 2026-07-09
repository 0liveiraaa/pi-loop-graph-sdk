# 2026-07-09 hybrid-node-mechanism 计划

> 目标：让节点支持代码 harness + agent ReAct 协作，落地 mechanism 运行时，修复 projection 的 input 泄漏。

---

## 改动 1：projection 删除 input 渲染

### 问题

`projection.ts` 的 `buildNodeInfo` 将 `input.data` 以 key-value 形式 dump 进 CURRENT 段。input 是 Edge.migrate 传给 `execute` 的代码侧入参，不应进入 agent 上下文。

### 盲区

图的首节点——用户命令/工具触发后的第一个节点——其 `input.data` 就是用户的 args/params。今天 agent 能看到它，只因为 projection 渲染了 `input:`。删除后，首节点若用默认 `createAgentExecute()`（默认 prompt "开始执行当前阶段"），agent 对用户意图完全失明。

受影响的 demo 图：
- `chain-graph.ts` — `echo_a`、`echo_b` 均用 `createAgentExecute()` 无显式 prompt
- `probe-graph.ts` — `probe` 用 `createAgentExecute()` 无显式 prompt
- `subgraph-graph.ts` — `child_agent` 用 `createAgentExecute()` 无显式 prompt

### 方案

**删 projection 的 input 渲染块**（`buildNodeInfo` 中约 6 行）。同时：

1. **demo 图修 prompt**：上述节点改用 `createAgentExecute({ prompt: (input) => ... })`，通过 `input.data` 显式构造 agent 可理解的问题
2. **`createAgentExecute` 默认 prompt 改明确**：从 "开始执行当前阶段" 改为发出警告——提醒 developer 这是无显式 prompt 的 agent 节点
3. **developer-guide 硬规则**：agent 需要知道的信息必须由 developer 在 `runAgent({ prompt })` 或 `createAgentExecute({ prompt })` 中显式传入。框架不自动 dump input

---

## 改动 2：developer-guide 重构「创建节点」章节

### 问题

当前文档分「Agent 节点」「纯代码节点」「复合节点」，暗示 `createAgentExecute` 创建了一种不同的节点类型。实际上 Node 只有两个 kind（code + graph），`createAgentExecute` 是语法糖。

### 方案

**更正叙事**：Node 有两个 kind：

| kind | 含义 |
|------|------|
| `"code"` | 可运行的 JS 函数，execute 里可以调 `ctx.runAgent` |
| `"graph"` | 委托子图执行 |

code 节点有三种典型用法（同一类型，不同写法）：

| 用法 | 写法 |
|------|------|
| agent-only | `execute: createAgentExecute({ skill: "...", prompt: ... })` |
| code-only | `execute: async (instance, input, ctx) => { return { ... } }` |
| hybrid | `execute: async (...) => { 代码 + ctx.runAgent(...) + 代码 }` |

`createAgentExecute` 降级为 "语法糖：最简单的 agent-only execute"。

---

## 改动 3：mechanism 运行时

> 另开计划文件 `2026-07-09_mechanism-runtime.md`，本文件只定改动 1/2。
