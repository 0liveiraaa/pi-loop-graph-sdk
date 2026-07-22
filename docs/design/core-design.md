# Loop Graph SDK 核心设计

> 稳定设计的精简说明。术语以 [术语表](../concepts/glossary.md) 为准。API 签名属于参考文档。

## 问题与定位

Agent 能在一次 ReAct 循环中调用工具并反复思考，但真实任务通常包含更高层的阶段变化：生成 → 检查 → 修改 → 再次检查。若全部隐藏在一个 Prompt 中，流程难以测试、观察和复用。

Loop Graph SDK 将这种工作建模为**可循环的有向图**：节点完成一个阶段，Connection + Transition 保存工作记忆并指向下一阶段，Route 从可用路径中选择一条。

当前定位：**单 Agent 串行编排 SDK**。支持子图、Code/Agent 混合节点、三层 Mechanism、三层工具权限、结构化验证、工作回放和 Node 边界恢复。不提供 fork/join、多 Agent 通讯或会话持久恢复。

## 核心心智模型

```text
Graph Input
  ↓
Entry → Stage(Node + Route) → Connection + Transition → Stage / finish()
                │
          node 内 ReAct（Agent 自由调用工具）
                │
          Completion → 验证链 → Route 选择
```

### Graph：模块边界

Graph 是任务的模块边界，声明目标、输入输出契约、入口和阶段装配。Graph 可以有多个 Entry（根据图输入选择不同起点）。Entry 按数组顺序 first-match。

### Stage：唯一装配结构

`stages: Record<StageId, Stage>` 是**唯一**图内装配结构。Stage ID 是图内运行身份。Stage 把可复用 Node Definition 和出口 Route 放在一起。

0.1 中的 `Graph.nodes + Graph.routing + NodeRouting.nodeId + Edge.from` 的四重身份声明被合并为单一 Stage。

### Node：可复用定义

Node Definition 不持有图内位置、from/to 或路由。同一个 `agentNode(...)` 可以放进多张图中。可选的 `identity: { name, version? }` 仅用于跨图追踪来源，不参与路由。

### Connection + Transition：拓扑与迁移分离

0.1 的 Edge 同时持有拓扑（from/to）和迁移逻辑（guard/migrate），无法独立复用。

0.2 拆分为：
- Connection：持有目标（`to`）和 Transition
- Transition：只负责 guard、frame（记忆）、map（输入映射）、output（终点输出）

Transition 可通过 `defineTransition()` 抽取并跨 Connection 复用。

### 数据与模型上下文分离

这是 0.2 最根本的设计决策。完整 Graph Input 和 Node Input 是代码侧数据，**绝不自动进入模型**。三层投影（Background、Focus、Memory）通过 `{ select, render }` 显式决定模型可见内容。

Selector 只决定安全边界（哪些数据可见），Renderer 只决定可读性（如何展示）。两者不混用。

### 三层作用域

Host → Graph → Node 三层作用域贯穿 Toolkit、Mechanism、Context 和执行边界。每层的权限和状态生命周期由安装位置决定，不因调用方式（call/compose/delegate）而偶然改变。

### Builder 与 Core 同构

`defineSingleAgentGraph` 和 `defineLinearGraph` 是 Builder，输出同一个 Core Graph 类型，由同一个 GraphRuntime 执行。没有第二套 Runtime 或图语义。

## 不做的事

- 图内并行分支
- 多 Agent 直接通讯
- 同一 Host 并发 Root Run
- 精确恢复模型 turn 或正在执行的工具调用
- 序列化 Pi Session、函数或外部连接
- 0.1 兼容层

## 相关文档

- [图模型](../concepts/graph-model.md) — 用户面向的概念
- [内部实现索引](../internals/README.md) — 维护者文档
- [ADR](../adr/) — 架构决策记录
