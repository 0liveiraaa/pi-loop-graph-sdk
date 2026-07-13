# 上下文与状态：数据应该放在哪里

Loop Graph SDK 有多种数据通道，它们的生命周期和可见范围不同。最重要的判断是：这份数据是业务流程的一部分，还是只服务于代码侧基础设施？

术语定义见[领域语言](glossary.md)。图的推进方式见[图模型](graph-model.md)。

## 四类核心数据

| 数据 | 生命周期 | 后续节点可见 | 默认进入模型上下文 | 适合保存 |
| --- | --- | --- | --- | --- |
| background | 一次图调用 | 整张图可读取 | 由上下文渲染策略决定 | 图级输入和稳定背景 |
| NodeInput | 一次节点访问 | 仅当前节点 | 由当前节点上下文决定 | 上一步传来的临时业务参数 |
| ContextFrame | AgentInstance 生命周期 | 后续节点可见 | 是，作为已完成工作记忆 | 后续阶段真正需要的业务记忆 |
| Mechanism state | AgentInstance 中某个 Mechanism 的生命周期 | 仅对应 Mechanism | 否 | 计数、缓存、审计状态、基础设施元数据 |

此外还有兼容性的 `instance.scratch`。它是同一 AgentInstance 内多个 Mechanism 可见的共享代码侧命名空间，不进入模型上下文。新 Mechanism 优先使用自己的 `ctx.state`，避免键名冲突。

## Background：整张图的调用背景

background 来自启动图时提供的输入，例如：

```text
用户目标、仓库路径、任务编号、运行模式
```

它在一次图调用中保持稳定，适合作为全图共同参考的背景。它不是节点之间逐步演化的工作状态；阶段产生的新结果应通过 Completion、Edge 和 Frame 显式迁移。

## NodeInput：本次进入节点的参数

NodeInput 是一次性的。第一个节点的输入由 Entry 从 background 构造，后续节点的输入由上一条 Edge 生成。

例如审查节点发现三个问题后，进入修改节点时可以传入：

```text
需要修改的问题列表、目标文件、修改优先级
```

NodeInput 适合精准地告诉当前节点“这一次要处理什么”。如果下一个节点仍需使用这些信息，必须由当前节点重新产出并经 Edge 继续传递，不能假设 NodeInput 会自动持久化。

## ContextFrame：留给后续阶段的工作记忆

ContextFrame 是 Edge 在节点离开时写入的业务记忆。它的内容完全由开发者定义，例如：

```ts
{
  artifact: "draft.md",
  reviewSummary: "事实正确，但缺少迁移说明",
  unresolvedIssues: ["missing migration section"],
}
```

SDK 不要求 frame 包含 `nodeId`、`status`、`summary` 或 `result`。这些只是早期兼容字段，不应作为新代码的固定结构。

Frame 应满足两个条件：

1. 后续 Agent 确实需要知道。
2. 内容比完整 ReAct 轨迹更短、更稳定。

不要把日志、临时计时器、事件订阅句柄或大型原始工具输出放进 Frame。

## Mechanism state：代码侧横切状态

Mechanism state 属于某个 Mechanism 和某个 AgentInstance。它可以跨该实例的多个节点访问保留，但不会进入模型上下文。

适合的内容包括：

- 当前实例累计发生了多少次工具拒绝。
- 一次性能分析的开始时间和统计值。
- 已执行过哪些审计检查。
- Mechanism 自己使用的小型缓存。

它不适合保存业务流程需要迁移的草稿、审查结论或用户选择。否则 Router、Edge 和后续节点无法从显式图数据中理解流程状态。

## Frame 还是 state

可以用一个简单问题判断：

> 如果删除这个 Mechanism，后续业务节点是否仍然需要这份数据？

- 如果需要，使用 Completion → Edge → Frame 或 NodeInput。
- 如果不需要，它只是横切扩展自己的工作数据，使用 Mechanism state。

### 应使用 Frame

- 生成节点产出的文档路径。
- 审查节点发现的未解决问题。
- 用户确认的业务选择。
- 后续 Agent 推理必须引用的事实。

### 应使用 state

- Mechanism 的工具调用计数。
- 验收命令最近一次耗时。
- 是否已经发送过某条诊断信息。
- 不希望模型看到的审计元数据。

## 数据如何向前流动

```text
Graph background
       ↓ Entry.mapInput
第一个 NodeInput
       ↓ Node.execute
NodeCompletion
       ↓ Edge.migrate
ContextFrame + 下一个 NodeInput
       ↓
后续节点
```

Mechanism state 位于这条业务迁移链旁边：它可以观察和约束执行，但不替代这条链。

## 模型能看到什么

模型上下文不等于 AgentInstance 的完整对象。通常只有以下内容会进入当前 Agent 的可见上下文：

- 当前图和节点需要展示的目标或说明。
- 当前节点的相关输入。
- 仍需保留的 ContextFrame。
- skill 或 Mechanism 通过受控上下文通道追加的内容。

Mechanism state、scratch、Runtime 控制状态和完整历史对话不会因为存在于代码内就自动暴露给模型。

## 子图对数据边界的影响

不同子图边界会改变 AgentInstance 和 Frame 是否共享：

- call 创建新的 AgentInstance，因此使用新的 frames 和 Mechanism state。
- compose 复用当前 AgentInstance，因此共享 frames 和 Mechanism state，但子图新增 frames 在返回前会归约。
- delegate 创建新的 Session 和 AgentInstance，因此两者都隔离。

具体选择见[子图调用边界](subgraph-boundaries.md)。

## 常见错误

### 把 Completion 当成长期记忆

Completion 只负责报告阶段结果。后续模型要看到什么，由选中的 Edge 折叠成 Frame。

### 用 state 绕过 Edge 传递业务状态

这会让图的迁移无法从节点输入和历史记忆中解释，也使替换 Mechanism 变得危险。

### 把所有结果都塞进 Frame

Frame 会影响后续模型上下文。只保留后续阶段真正需要的信息，避免上下文不断膨胀。

### 依赖 scratch 的共享键名

scratch 是兼容通道且没有私有命名空间。新代码优先使用类型化 Mechanism state。
