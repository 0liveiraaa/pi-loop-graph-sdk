# 上下文与状态：数据应该放在哪里

Loop Graph SDK 有多种数据通道，生命周期和可见范围不同。核心判断：这份数据是业务流程的一部分，还是代码侧基础设施？

术语定义见[术语表](glossary.md)。

## 数据通道总览

| 数据 | 生命周期 | 模型可见 | 适合保存 |
|------|----------|----------|----------|
| Graph Input | 一次图调用 | 否（需通过 Background 投影） | 图级输入、配置 |
| Background | 一次 Graph Invocation | 是（sticky） | 图级稳定背景 |
| Node Input | 一次 Node Visit | 否（需通过 Focus 投影） | 阶段间临时业务参数 |
| Node Focus | 一次 Node Visit | 是（sticky） | 当前节点要集中处理的数据 |
| Frame / Memory | 一次 Graph Invocation | 是（foldable） | 已完成阶段的工作记忆 |
| Output Contract | 一次 Agent Run | 是（sticky，protected） | 当前 run 的输出格式 |
| Mechanism state | 安装 scope | 否 | 计数、缓存、审计 |
| Contribution | 声明 scope | 声明 retention 控制 | Mechanism 追加的上下文 |

## 数据与模型上下文分离

这是 0.2 最核心的设计原则。完整 Graph Input 和 Node Input 是代码侧数据，不会自动注入模型。只有经过显式投影（`{ select, render }`）的内容才成为模型可见上下文。

### 三层投影

```text
Graph Input  ──background.select──→  Background  ──render──→  模型看到
Node Input   ──focus.select──────→  Node Focus  ──render──→  模型看到
Frames       ──memory.select─────→  Memory      ──render──→  模型看到
```

每层 `select` 决定"哪些数据允许进入"，`render` 决定"如何展示"。

**约束：**
- `select` 的参数是该层唯一允许读取的完整业务来源
- `render` 只能读取 selected 和 meta，不能读 selector 未选择的数据
- Background 在 Graph Invocation 建立时物化一次并冻结
- Node Focus 在 Node Visit 建立时物化一次并冻结
- Memory 在 Frame revision 变化后重新物化并缓存

### Background

```typescript
context: {
  background: {
    select: (graphInput) => ({
      topic: graphInput.topic,         // ← 选了
      // sourceFiles 和 internalJobId 没选，模型永远看不到
    }),
    render: ({ selected, meta }) => [
      `=== GRAPH GOAL ===\n${meta.graph.goal}`,
      `=== BACKGROUND ===\n${JSON.stringify(selected)}`,
      ...meta.skills.map(s => s.content),
    ],
  },
}
```

**必填**，必须显式写 `"all"`、`"none"` 或 selector 函数。

### Memory

已完成阶段的 Frame 数据对后续节点可见：

```typescript
context: {
  memory: {
    select: (frames) => frames.map(f => f),
    render: ({ selected }) =>
      selected ? `=== COMPLETED WORK ===\n${JSON.stringify(selected)}` : null,
  },
}
```

Frame 通过 Transition 的 `frame()` 写入：

```typescript
connect("next", {
  frame: ({ completion }) => ({ stage: "analyze", result: completion.result }),
}),
```

### Node Focus

```typescript
// Agent Node：默认 "all"
const node = agentNode({
  context: {
    focus: {
      select: (nodeInput) => ({ excerpts: nodeInput.excerpts }),
      render: ({ selected, meta }) => [
        `=== NODE SUBGOAL ===\n${meta.node.subGoal}`,
        `=== NODE FOCUS ===\n${JSON.stringify(selected)}`,
      ],
    },
  },
});

// Code Node：默认 "none"（不写模型上下文）
// 只有显式配置 context.focus 后，内部 runAgent() 才获得 Node Focus
```

## 默认行为汇总

| 配置 | 默认 |
|------|------|
| `Graph.context.background.select` | **必填**，无默认值 |
| `Graph.context.background.render` | 省略时使用 SDK 默认 renderer |
| `Graph.context.memory` | 省略时投影全部 Frame |
| Agent Node `context.focus` | `select: "all"` |
| Code Node `context.focus` | `select: "none"` |
| Graph Node context | 不建立 Node Context（focus）；子图建立自己的 Graph Context（background + memory） |
| Output Contract | Runtime protected，不受 renderer 控制 |

## 一次 Agent Run 的模型实际可见内容

Context Runtime 在每次 LLM call 前组装：

```text
Host baseline
→ Graph goal + Background + Graph Skills
→ Memory（已完成 Frames）
→ Node subGoal + Node Focus + Connections + Node Skills
→ Mechanism sticky contributions
→ Output Contract（protected，Agent Run scope）
→ prompt
→ 当前 run 的 Assistant / Tool transcript
```

纯 Code Node（未调用 `runAgent()`）不会向模型写入任何上下文消息。

## Mechanism 上下文追加

Mechanism 通过 `ctx.context.add(key, content, { lifetime, retention })` 向 Context State 追加内容：

- `lifetime`：`"agent-run"` | `"node-visit"` | `"graph-invocation"` | `"root-run"`
- `retention`：`"sticky"`（每次 LLM call 重投影）| `"foldable"`（允许压缩摘要）| `"transient"`（下次 LLM call 后删除）

不能创建比安装 scope 更长的 contribution。Host Mechanism 最大 root-run，Graph Mechanism 最大 graph-invocation，Node Mechanism 最大 node-visit。

## 相关文档

- [自定义上下文](../guides/customize-context.md) — 实操指南
- [Mechanism](../concepts/mechanisms.md) — contribution lifetime 详解
- [图模型](../concepts/graph-model.md) — Frame 和 Transition
