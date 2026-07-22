# 子图调用边界：call、compose 与 delegate

Graph 可以把另一张图作为节点调用。调用边界决定父图和子图共享工作记忆和上下文隔离的程度。

## 边界对比

| 边界 | 工作记忆 | 工具/机制/Skills | 典型用途 |
|------|----------|-----------------|----------|
| **call**（默认） | 独立 | 声明和状态独立（Host Catalog 共享） | 独立子任务 |
| **compose** | 共享 Frames | 声明和状态独立（Host Catalog 共享） | 用子图实现父节点内部流程 |
| **delegate** | 独立 | 完全独立（独立 Host） | 强隔离、长任务 |

三种边界都只通过明确输入启动子图。子图的工具权限、Graph Mechanism 和 Skills 由子图自身声明，父图不重复声明，也不限制。

## Call：独立工作区

```typescript
import { Type, graphNode, graphRef } from "pi-loop-graph-sdk";

const subRef = graphRef("price-check", "1");
const checkNode = graphNode({
  subGoal: "运行价格检查",
  input: Type.Object({}),
  output: Type.Object({}),
  graph: subRef,
  boundary: "call",
});
```

- 子图看不到父图的 Frames
- 子图拥有新的 Graph Mechanism state
- 子图结束后 Frames 随子图一起销毁

## Compose：共享工作记忆

```typescript
graphNode({ subGoal: "运行子流程", input: Type.Object({}), output: Type.Object({}), graph: subRef, boundary: "compose" }),
```

- 子图可以读写父图的 Frames（Memory 投影对父图后续节点可见）
- **只共享 Frames**：工具、Graph Mechanism、Skills 仍然是子图自己的
- 适合"把复杂逻辑拆成子图但仍希望工作记忆贯通"的场景

## Delegate：独立 Host

```typescript
graphNode({ subGoal: "运行独立任务", input: Type.Object({}), output: Type.Object({}), graph: subRef, boundary: "delegate" }),
```

- 子图在独立 Session 中运行
- 完全隔离：不共享 Frames、工具、Mechanism 或 Session transcript
- 适合长任务、需要独立压缩生命周期、或安全隔离场景

## Call/Compose 的运行时实现

call 和 compose 子图中的 Agent Run 使用**临时 Pi child Session**：

- 每个 Graph Invocation 创建独立 child Session
- child Session 继承必要的 Host 配置（模型、认证、工具实现、recording sink）
- **不继承**父 Session transcript、compaction summary 或活动 Output Contract
- 子图返回、失败或取消后 child Session 自动 abort/dispose
- compose 的 Frames 共享通过 Core Runtime 的显式 Memory 投影实现，**不通过 Session messages 共享**
- 父图通过子图的 Graph output 获取最终结果；compose 还额外通过共享 Frames 看到子图的工作记忆

## 相关文档

- [调用子图](../guides/call-subgraphs.md) — 实操指南
- [图模型](../concepts/graph-model.md) — GraphRef 与 graphNode
- [内部：运行时边界](../internals/runtime-boundaries.md) — 实现协议
