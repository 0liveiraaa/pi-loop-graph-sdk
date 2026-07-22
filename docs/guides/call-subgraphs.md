# 调用子图

## 适用场景

你需要把一张 Graph 作为阶段嵌入另一张 Graph。概念见[子图调用边界](../concepts/subgraph-boundaries.md)。

## 前置：注册子图

使用 `graphNode` 调用子图前，子图必须在 Graph Catalog 中注册：

```typescript
import { createLoopGraphExtension, graphRef } from "pi-loop-graph-sdk";

const loop = createLoopGraphExtension(pi);
loop.registerGraph(subGraph); // 注册到 Catalog，使其可被 GraphRef 解析
```

## Call：独立工作区（默认）

```typescript
import { Type, graphNode, graphRef } from "pi-loop-graph-sdk";

const verifyNode = graphNode({
  subGoal: "验证价格",
  input: Type.Object({}),
  output: Type.Object({}),
  graph: graphRef("price-check", "1"),
  boundary: "call",
});
```

- 子图看不到父图的 Frames
- 子图拥有独立的 Graph Mechanism state
- 父图只通过子图的 returned output 获取结果

## Compose：共享工作记忆

唯一区别是 `boundary: "compose"` 和子图 Transition.frame 写入的 Frame 对父图后续节点可见：

```typescript
graphNode({
  subGoal: "运行分析子流程",
  input: Type.Object({}),
  output: Type.Object({}),
  graph: graphRef("analyze", "1"),
  boundary: "compose",
}),
```

**注意**：只共享 Frames（工作记忆）。子图的工具权限、Graph Mechanism 和 Skills 仍然是子图自己的。

## Delegate：独立 Host

```typescript
graphNode({
  subGoal: "运行独立长任务",
  input: Type.Object({}),
  output: Type.Object({}),
  graph: graphRef("long-task", "1"),
  boundary: "delegate",
}),
```

子图在完全独立的 Host/Session 中运行。直接使用 `createGraphHost` 时，需要通过 `runtime.delegateGraph` 提供 delegate 执行实现；Pi Extension 会由其 Adapter 注入该能力。

## 运行过程

以 call 为例：

```text
父图正在执行 graphNode
  → 创建临时 Pi child Session
  → 以子图 input schema 校验调用输入
  → 运行子图（子图使用自己的 Graph Context、Tools、Mechanisms）
  → 子图 finish() 产出 output
  → child Session 销毁
  → 子图 output 变成父图 graphNode 的 completion.result
  → 父图 Route 选择下一条 Connection
```

child Session 继承 Host 配置（模型、认证、工具实现、recording sink），**不继承**父 Session transcript 或 compaction summary。

## 工具权限

子图使用自己的 Graph Tool Policy，父图不需要重复声明子图的内部工具。Host 缺失子图需要的工具时在注册或执行前明确失败。

## 递归

Graph 可以直接或间接递归调用。所有递归共享 Root Run Invocation Budget：maxGraphDepth 8、maxGraphInvocations 64、maxTotalNodeVisits 500。

## 相关文档

- [子图调用边界](../concepts/subgraph-boundaries.md) — 概念详解
- [控制节点工具](control-tools.md) — 工具权限三层模型
- [API 参考](../reference/api.md) — graphNode、graphRef 签名
