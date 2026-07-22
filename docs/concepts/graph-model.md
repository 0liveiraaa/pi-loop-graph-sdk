# 图模型：用阶段和迁移表达 Agent 工作流

Loop Graph SDK 把复杂任务拆成若干阶段，让阶段之间的迁移显式可见。它适合"生成 → 检查 → 修改 → 再次检查"这类需要循环但仍希望保持结构清晰的 Agent 工作流。

术语定义见[术语表](glossary.md)。

## 一张图包含什么

```
Graph Input（调用方传入的完整数据）
   ↓
 Entry（匹配规则 → 选起始阶段）
   ↓
 Stage（Node + Route）
   │
   ├─ Node 执行 → Completion
   │
   └─ Route 选 Connection → Transition
       │
       ├─ 下一 Stage（循环）
       │
       └─ finish() → Graph Output
```

### Graph：任务边界

Graph 是任务的整体边界，声明：

| 字段 | 说明 |
|------|------|
| `id` + `version` | 唯一标识，用于注册、调用和回放 |
| `goal` | 图的总目标，会出现在模型上下文中 |
| `input` | 完整运行输入的数据契约（TypeBox schema） |
| `output` | finish() 产出的数据契约 |
| `context` | 模型上下文策略：background、memory 的 select/render |
| `entries` | 入口列表，按数组顺序 first-match |
| `stages` | `Record<StageId, Stage>`，图内唯一装配结构 |
| `tools` | 图工具权限（`toolSet("read", "write")`） |
| `skills` | 图级 Skill 引用 |
| `mechanisms` | 图级 Mechanism |

### Stage：装配位置

Stage 是图内的装配结构，把一个 Node Definition 和它的出口 Route 放在一起。Stage ID 是图内唯一运行身份——在事件、回放和结果中用作标识。

```typescript
stages: {
  analyze: {          // ← Stage ID，图内唯一
    node: 分析节点,    // ← Node Definition（可跨图复用）
    route: firstMatch({ ... }),
  },
}
```

### Node Definition：可复用工作阶段

Node Definition 不持有图内位置。同一个 `agentNode({...})` 可以放进多张图的 stages 中。

三种类型：

- **`agentNode`**：让模型完成一个子目标。Runtime 自动处理 Agent Run、工具调用和结果提交。
- **`codeNode`**：运行确定代码。内部可通过 `runAgent()` 任意次数调用模型。
- **`graphNode`**：把另一张图作为阶段实现。通过 `graphRef(id, version)` 引用。

### Entry：从哪里开始

Entry 根据 Graph Input 判断是否匹配，匹配后选择起始阶段及初始 Node Input：

```typescript
entries: [
  entry("create", {
    guard: (input) => input.mode === "create",
    to: "draft",
    mapInput: (input) => ({ topic: input.topic }),
  }),
  entry("review", {
    guard: (input) => input.mode === "review",
    to: "check",
  }),
],
```

### Route 和 Connection：去哪里

节点的出口由 Route 管理。`firstMatch` 按数组顺序取首个 guard 匹配的 Connection：

```typescript
route: firstMatch({
  retry: connect("analyze", {           // guard 匹配 → 回到 analyze
    guard: (result) => result.needsRevision,
  }),
  next: connect("answer", {             // 默认 → 继续到 answer
    map: ({ completion }) => completion.result,
  }),
  done: finish({                        // guard 匹配 → 结束
    guard: (result) => result.isComplete,
    output: ({ completion }) => completion.result,
  }),
}),
```

### Transition：如何迁移

Transition 是 Connection 的迁移策略：

| 函数 | 说明 | 用于 |
|------|------|------|
| `guard` | 条件：是否走这条连接 | Connection 选择 |
| `frame` | 保存工作记忆，后续节点可通过 Memory 投影看到 | 跨阶段共享 |
| `map` | 构造下一个节点的 Node Input | 阶段间传数据 |
| `output` | **仅 finish()**：产生 Graph Output | 图返回值 |

`frame` 写入的数据在整个 Graph Invocation 的后续节点中可见。

### finish()：图终点

`finish()` 是指向 `__graph_finish__` 的特殊 Connection。**必须提供 `output` 函数显式产生符合 Graph output 契约的值。** 不再从工作记忆或 completion 猜测返回值。

```typescript
done: finish({
  output: ({ completion }) => ({
    answer: completion.result.answer,
    sources: completion.result.sources,
  }),
}),
```

## Builder：简化常见模式

### defineSingleAgentGraph

单节点图：

```typescript
const graph = defineSingleAgentGraph({
  id: "echo", version: "1", goal: "...",
  input: InputSchema, output: OutputSchema,
  context: { background: { select: "all" } },
  node: agentNode({ subGoal: "...", prompt: "...", input: InputSchema, output: OutputSchema }),
});
```

### defineLinearGraph

```typescript
const graph = defineLinearGraph({
  id: "pipeline", version: "1", goal: "...",
  input: InputSchema, output: OutputSchema,
  context: { background: { select: "all" } },
  nodes: [nodeA, nodeB, nodeC],
});
```

上一节点的 `completion.result` 自动映射为下一节点的 Node Input；末节点自动映射到 `finish()` output。

两种 Builder 都只生成 Core Graph，由同一个 Runtime 消费。

## 校验与冻结

`defineGraph()` 构建时校验并浅冻结：
- 重复 Entry ID → 构建失败
- 重复 Connection ID → 构建失败
- Connection 目标 Stage 不存在 → 构建失败
- `finish()` 缺少 output → 构建失败
- 非法 `graphRef` → 构建失败

注册时进一步校验 Host 工具、Skill 和 delegate 能力。
