# 任务 03：核心概念文档

## 目标

把稳定心智模型从庞大的开发者指南和设计文档中提取出来，让用户先理解系统如何思考，再查 API。

## 目标文件

创建目录 `docs/concepts/`，建议包含：

- `graph-model.md`
- `context-and-state.md`
- `subgraph-boundaries.md`
- `mechanisms.md`

## 各文件职责

### graph-model.md

解释 Graph、Entry、Node、NodeCompletion、Edge、Router、END，以及节点内 ReAct 循环与图上阶段循环的区别。

### context-and-state.md

解释四类容易混淆的数据：

- background：图调用输入。
- NodeInput：本次进入节点的一次性输入。
- ContextFrame：显式进入后续模型历史的工作记忆。
- Mechanism state/scratch：代码侧横切状态，不进入模型上下文。

不要从 NodeScope 投影算法开始讲。

### subgraph-boundaries.md

用一张表和三个具体场景解释：

- call：同一 Session，新 AgentInstance，历史隔离。
- compose：同一 Session、同一 AgentInstance，临时历史最终归约。
- delegate：新 Session、新 AgentInstance，强隔离。

### mechanisms.md

解释 Mechanism 是横切扩展，不是节点、Router 或业务状态迁移通道。区分观察 Hook、决策 Hook、安全能力和完整 `ctx.pi`。

## 禁止内容

- 不复制完整接口定义。
- 不以 Phase 0–8 讲述能力。
- 不讲具体 WeakMap、listener 数量和内部类名。
- 不把 future communication design 当成现有概念。

## 验收

- 每个文件独立阅读成立，且不超过约 250 行。
- 同一概念只在一个文件中完整定义，其他文件使用链接。
- 读者能回答“什么时候用 frame，什么时候用 state”。
- 读者能仅凭边界表选择 call、compose 或 delegate。

