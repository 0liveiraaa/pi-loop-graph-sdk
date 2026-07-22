# 自定义上下文：控制模型看到什么

## 适用场景

你需要精确控制每个阶段模型看到的内容——哪些背景数据暴露、已完成工作如何展示、当前节点要关注什么。

概念见[上下文与状态](../concepts/context-and-state.md)。

## 三层投影协议

每层使用相同的 `{ select, render }` 协议：

```typescript
// select：选择哪些数据 → 决定安全边界
// render：如何展示 → 决定可读性
```

### Graph Background：图级稳定信息

```typescript
const graph = defineGraph({
  context: {
    background: {
      // 必填！必须显式写 "all"、"none" 或 selector
      select: (graphInput) => ({
        topic: graphInput.topic,
        requirements: graphInput.requirements,
        // sourceFiles 没选 → 模型永远看不到
      }),

      // 可选：自定义展示。省略时使用 SDK 固定默认 renderer。
      render: ({ selected, meta }) => [
        `=== GRAPH GOAL ===\n${meta.graph.goal}`,
        selected ? `=== BACKGROUND ===\n${JSON.stringify(selected)}` : null,
        ...meta.skills.map(s => s.content),
      ].filter(Boolean).join("\n\n"),
    },
  },
});
```

`meta` 包含 `graph.goal`、`graph.id/version`、`skills`（已解析内容），**不包含完整 Graph Input**。

### Memory：已完成工作的历史

```typescript
context: {
  memory: {
    select: (frames) => frames.map(f => f),
    render: ({ selected }) =>
      selected?.length
        ? `=== COMPLETED WORK ===\n${JSON.stringify(selected)}`
        : null,
  },
}
```

省略 `memory` 时默认投影全部 Frame。

### Node Focus：当前节点的关注点

```typescript
const node = agentNode({
  context: {
    focus: {
      select: (nodeInput) => ({
        excerpts: nodeInput.excerpts,
        // 节点不需要的字段不选
      }),
      render: ({ selected, meta }) =>
        `=== SUBGOAL ===\n${meta.node.subGoal}\n=== FOCUS ===\n${JSON.stringify(selected)}`,
    },
  },
});
```

`meta` 包含 `node.subGoal`、`node.kind`、`skills`、`connections`。

## Renderer 覆盖

Graph/Node renderer 定义在各自的 `context` 配置中。省略 `render` 时使用 SDK 固定默认 renderer。

## 安全约束

- renderer 只能读取 `selected` 和 `meta`，**不能读取 selector 未选择的数据**
- renderer 不能删除 Runtime protected 层（Output Contract）
- 每一层 renderer 只负责自己的投影

## 相关文档

- [上下文与状态](../concepts/context-and-state.md) — 概念详解
- [图模型](../concepts/graph-model.md) — Frame 与 Transition
- [Mechanism 上下文追加](mechanism-hooks.md) — ctx.context.add
