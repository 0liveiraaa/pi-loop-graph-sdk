# 内部协议：Mechanism Runtime

> 维护者文档。普通 Mechanism 作者应阅读概念和 API 指南，而不是依赖本文内部结构。

## 设计目标

Mechanism 需要在一个节点中观察和约束 Agent 工作，同时满足：

- 节点退出后临时资源失效。
- pi 没有 off 的事件 API 不导致每次访问增加底层 listener。
- 多个 Mechanism 按确定顺序组合。
- 工具 patch 和 completion gate 受到 Runtime 校验。
- Hook 错误在安全检查点进入图控制流。
- 完整 `ctx.pi` 仍保持可用，但不伪装成托管能力。

## 定义、实例状态和调用状态

三种寿命必须分离：

| 层次 | 寿命 | 内容 |
| --- | --- | --- |
| Mechanism definition | 业务定义寿命 | name、Hook、failurePolicy、createState |
| Mechanism state | AgentInstance × definition | 跨节点计数、缓存和审计状态 |
| Mechanism invocation | 单次节点访问 | signal、events、cleanup、临时资源 |

同名的两个 definition 不是同一 Mechanism。state 按对象身份隔离，避免名字冲突。call/delegate 新建 AgentInstance，因此获得新 state；compose 复用 AgentInstance，因此复用 state。

createState 懒初始化一次。初始化失败会被记录，并跳过依赖无效 state 的 Hook。

## Invocation group

一次节点访问为每个生效 Mechanism 创建独立 invocation scope，并由 group 统一持有。

scope 包含：

- 当前节点访问身份。
- 独立 AbortSignal。
- 同时检查 invocation active 和 Runtime 当前 scope 的 isActive。
- cleanup 注册栈。

group 关闭时按 Mechanism 逆序关闭 invocation；每个 invocation 先标记 inactive，再 abort，最后按 LIFO 执行 cleanup。一个 cleanup 错误不会阻止其他 cleanup，也不会覆盖主运行错误。

## 生效顺序

Mechanism 的组合顺序固定为：

```text
AgentInstance mechanisms
→ 当前 compose 调用帧的 local mechanisms
→ Node mechanisms
```

Hook 和工具决策按该顺序串行执行。当前 Runtime 不提供 priority、dependsOn 或并行 Hook。

## Event broker

pi 的 `on()` 返回 void，没有对应 off。如果每次节点访问直接注册底层事件，会让 listener 永久累积。

MechanismEventBroker 因此在 Extension 创建时为每种支持事件只注册一个底层 handler，再把只读快照分发给当前活动 scope 的订阅者。SDK subscription 的 dispose 只从 broker 表中移除记录，不假装调用不存在的 pi off。

节点 scope 关闭时自动 dispose 订阅。手动 dispose 幂等。

## Agent run 归属

一次节点访问可以多次调用 runAgent。broker 在每次 run 开始时绑定独立 agentRunId，正式 turn/tool Hook 只处理当前活动 run。

run 结束后清除绑定；两次 run 之间的晚到事件不会被归到下一轮。当前 Session 不允许重叠的 runAgent Mechanism lifecycle。

动态 `ctx.events` 订阅仍按节点 scope 分发，正式 Hook 额外获得 agentRunId 归属。

## 事件快照和预算

Hook 不接收 pi 的 live mutable event。Runtime 复制并冻结普通对象和数组，避免前一个 Mechanism 通过别名修改后一个 Mechanism 的输入。

工具结果快照受字节预算约束，并标记是否截断。预算限制观测载荷，不修改原始 Runtime details。

## 工具调用决策

beforeToolCall 管线：

1. 从原始输入创建只读快照。
2. 按 Mechanism 顺序调用 Hook。
3. allow 保持当前输入。
4. patch 用返回对象替换当前输入，交给下一个 Mechanism。
5. deny 立即停止管线并阻止工具执行。
6. 每次 patch 后按工具 schema 重新校验；没有可靠 schema 时 fail closed。
7. 最终输入原地写回 pi event，兼容上游事件契约。

`__graph_complete__` 不允许普通 patch，其控制 ABI 由 completion 管线负责。

## 工具结果决策

afterToolResult 按顺序读取当前模型可见结果。Mechanism 只能：

- keep
- replace content
- 设置 isError

toolCallId、toolName 和 Runtime details 不对决策 Hook 开放修改。全部决策完成后，正式 onToolResult 和动态订阅看到预算化的最终快照。

## Completion gate

仅 `status: ok` 的 Completion 进入 Mechanism gate。每个 Hook 在 scope signal 和 timeout 下串行执行：

- allow 可产生 verifiedResult。
- reject 停止后续 gate，并复用 Agent retry 回路。
- fail-node/fail-graph 写入待消费控制失败。

多个 allow 产生的可信结果按 Mechanism 名称和结果组成 checks 数组，与 Agent result 分离。重复 Completion 在同一 run 内去重；并发 agent_end 被串行化，验收未完成前 run Promise 不 resolve。

## Failure policy 与安全检查点

Hook 运行在 pi 事件回调中时，直接抛出 fail-node/fail-graph 可能打断上游事件分发并形成随机控制流。broker 因此记录 pending failure，由图循环在执行前、节点主体后和 exit Hook 后的安全检查点消费。

控制优先级是：

```text
fail-graph > fail-node > continue
```

fail-node Completion 的 nodeId 和诊断字段由 Runtime 生成，不接受 Mechanism 伪造。已有主错误时，onNodeError 自身失败只作为附加诊断。

## 托管命令执行

`ctx.exec.run()` 包装 pi exec：

- 绑定 scope signal。
- 应用默认或显式 timeout。
- 限制 cwd 是否位于受控根目录。
- 分别截断 stdout/stderr。
- 返回冻结结果和截断标记。

scope 失效后不能启动新命令；运行中的命令应响应 abort。

## 完整 `ctx.pi`

Runtime 不代理或削弱 `ctx.pi`。直接使用它注册的事件、消息、工具和后台任务不进入 invocation group，也不获得自动取消和 failure checkpoint。

这是有意保留的高级逃生口，不应在内部实现中尝试检测、撤销或改写其副作用。

## 主要代码与测试入口

- `src/adapter/mechanism-runtime.ts`：scope、state、broker、工具与 completion 管线。
- `src/adapter/loop-graph-extension.ts`：Mechanism 准备、Hook 调度和控制失败消费。
- `src/adapter/pi-node-context.ts`：Agent run 与 completion retry 桥接。
- `src/adapter/loop-graph-extension.test.ts`：生命周期、state、事件、工具、exec 和 gate 回归。
