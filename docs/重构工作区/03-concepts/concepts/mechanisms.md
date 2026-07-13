# Mechanism：围绕节点工作的横切扩展

Mechanism 用于把工具权限、执行观测、自动验收、计时、审计和资源清理等横切能力附加到节点工作过程，而不把这些逻辑复制到每个 Node 中。

Mechanism 不是节点、Router 或业务状态迁移通道。术语定义见[领域语言](../设计/CONTEXT.md)，业务数据边界见[上下文与状态](context-and-state.md)。

## Mechanism 负责什么

适合 Mechanism 的需求通常具有以下特征：

- 会作用于多个节点。
- 关注 Agent、turn、工具或完成验收的生命周期。
- 需要在节点结束时自动取消或清理资源。
- 需要观察或约束行为，但不负责选择下一节点。

典型例子包括：

- 记录节点和工具耗时。
- 禁止读取受保护路径。
- 修改工具参数以满足安全策略。
- 脱敏工具返回给模型的内容。
- 在 Agent 声称完成后运行真实测试。
- 为当前节点追加受控上下文。

## Mechanism 不负责什么

以下职责应留在图和节点中：

- 决定接下来进入哪个节点：由 Router 和 Edge 负责。
- 保存后续业务阶段需要的结果：由 Completion、Edge、Frame 和 NodeInput 负责。
- 实现一个独立业务阶段：由 Node 负责。
- 选择 call、compose 或 delegate：由 graph node 的边界负责。
- 隐藏式改变整张图的目标或调用栈：不属于托管 Mechanism 能力。

如果一段逻辑改变了业务流程拓扑，它通常不应是 Mechanism。

## 定义与一次调用

Mechanism 定义可以挂在整张 Graph 或单个 code node 上，并在多个节点执行周期中复用。graph node 当前不提供节点级 `mechanisms` 字段，但其子图仍可声明图级或 code node 级 Mechanism。

当工作实例进入一个节点时，每个生效的 Mechanism 会获得一次临时调用。它的有效期就是当前节点执行周期：

```text
进入节点
→ 创建 Mechanism 调用
→ 节点与 Agent/工具 Hook
→ 节点完成或出错
→ 取消临时任务并执行 cleanup
```

同一节点因图循环再次进入时，会产生新的节点执行周期和新的临时调用。长期私有 state 可以复用，但事件订阅、进程和其他临时资源不应跨周期存活。

## 四类接入方式

### 观察 Hook

观察 Hook 读取只读生命周期信息，不直接改变结果，例如：

- Agent 即将开始运行。
- turn 开始或结束。
- 工具开始或完成。
- 节点正常结束或发生错误。

适合日志、指标、审计和 state 更新。

### 决策 Hook

决策 Hook 返回 SDK 允许的有限决定，例如：

- 允许、拒绝或修改工具输入。
- 保留或替换模型可见的工具结果。
- 允许完成、要求 Agent 重试、让节点失败或让整张图失败。

决策 Hook 不能返回任意 Runtime 修改，也不能伪造工具身份、节点身份或调用边界。

### 托管安全能力

Mechanism context 提供一组与节点执行周期绑定的能力：

- `ctx.scope`：取消信号、活跃检查和 cleanup 注册。
- `ctx.state`：该 Mechanism 的实例级私有状态。
- `ctx.events`：随节点退出自动失效的事件订阅。
- `ctx.exec.run()`：受取消、超时、工作目录和输出大小约束的命令执行。
- `ctx.context.append()`：向当前节点追加文本或图片上下文，不触发额外 turn。
- `ctx.decisions`：读取工具决策记录。

优先使用这些能力，可以获得明确的生命周期和组合语义。

### 完整 `ctx.pi`

`ctx.pi` 保留完整的 pi ExtensionAPI，适合托管能力尚未覆盖的高级定制。它不是 deprecated API，也不会被权限开关隐藏。

但它属于非托管能力：

- 直接注册的 pi 事件不会在节点结束时自动移除。
- 额外消息或 turn 不自动获得节点隔离保证。
- 后台 Promise 的错误不一定进入 Mechanism failurePolicy。
- 修改工具、模型或 provider 可能与其他 extension 产生顺序冲突。

使用 `ctx.pi` 时，Mechanism 作者负责资源所有权、清理和冲突处理。

## State 与节点执行周期资源

Mechanism 中有两种不同寿命的数据。

### `ctx.state`：跨节点保留

state 属于当前 AgentInstance 中的这个 Mechanism。适合计数、审计状态或小型缓存。

call 和 delegate 创建新的 AgentInstance，因此得到新的 state；compose 复用父级 AgentInstance，因此复用 state。

### `ctx.scope`：只属于当前节点访问

计时器、事件订阅、锁、临时文件句柄和运行中的外部命令属于当前节点执行周期。它们应绑定 scope signal，或通过 cleanup 显式释放。

不要把这类临时资源放进长期 state，否则节点退出后它们仍可能持有无效引用。

## 业务状态仍应显式迁移

Mechanism 可以观察 Completion，但不应把业务结果偷偷写入 state，再让后续节点从 state 读取。

例如“审查发现的问题列表”是业务流程的一部分，应由审查节点产出，并通过 Edge 写入 Frame 或下一个 NodeInput。只有“审查 Mechanism 已运行几次”这类基础设施数据适合 state。

判断方法见[Frame 还是 state](context-and-state.md#frame-还是-state)。

## 工具控制的组合方式

多个 Mechanism 按确定顺序处理工具调用：

1. 每个 Mechanism 只看到当前输入的只读快照。
2. patch 会成为下一个 Mechanism 看到的新输入。
3. 任一 deny 会停止工具执行。
4. 修改后的输入必须重新通过工具 schema 校验。
5. completion 工具具有固定协议，不接受普通工具参数 patch。

结果 Hook 只能改变模型可见内容和错误标记，不能改写工具名称、调用 ID 或 Runtime 私有 details。

## 自动验收

Completion gate 允许 Mechanism 在 Agent 声称完成后运行真实检查，例如单元测试、lint 或制品验证。

它可以：

- allow：放行，并附加 Runtime 生成的可信验收结果。
- reject：把原因反馈给 Agent，让其继续修改后再次完成。
- fail-node：以可信失败结束当前节点。
- fail-graph：终止当前图调用。

可信验收结果与 Agent 自报 result 分离，因此 Agent 无法仅靠填写“测试已通过”覆盖真实检查结论。

## 失败策略

Mechanism 可以声明 Hook 出错后的策略：

- continue：记录错误并继续，适合非关键观测。
- fail-node：让当前节点失败，但仍交给图上的 Router 和 Edge 处理。
- fail-graph：终止当前图调用。

安全门禁和可信验收通常不应采用默认的 fail-open 行为；应根据业务风险显式选择失败策略。

## 什么时候使用 Mechanism

使用 Mechanism：

- 同一能力需要覆盖多个节点。
- 需要生命周期 Hook、自动清理或安全决策。
- 逻辑属于观测、权限、审计、验收或基础设施。

使用 Node：

- 逻辑本身是一个业务阶段。
- 它产出需要被 Router 判断的 Completion。

使用 Edge：

- 逻辑决定什么时候迁移、留下什么工作记忆、给下一节点什么输入。

使用普通 extension/pi API：

- 能力天然属于整个 Session，而不是某个节点执行周期。
- 你明确愿意自行管理全局生命周期和冲突。

## 继续阅读

- 图如何推进：[图模型](graph-model.md)
- 数据放在哪里：[上下文与状态](context-and-state.md)
- Mechanism state 在子图中的隔离方式：[子图调用边界](subgraph-boundaries.md)
