# 内部协议：图调用栈与边界恢复

> 维护者文档。本文说明 root、call、compose、delegate 如何保持工作身份、历史和 Session 边界。

## 两个正交维度

图调用来源回答“谁发起”：command、tool、graph-node 或 api。调用边界回答“共享什么”：call、compose 或 delegate。来源不能隐式决定边界。

Runtime 内的同步嵌套调用使用 callStack。每一层记录当前 Graph、逻辑工作实例、调用 background、活动节点、节点访问计数和 frame 投影 baseline。

delegate 不在同一 callStack 内运行；它由独立 GraphExecutionHost 承载。

## Root

顶层运行创建 GraphRuntime 和初始 AgentInstance，并压入 root 调用帧。一个 LoopGraphExtension 实例同一时刻只允许一个 root executeGraph，避免同一 Session 上的活动 Runtime 和 NodeContext 互相覆盖。

嵌套 call/compose 属于该 root 的同步调用链，不被视为第二个并发 root。

## Call

call 在当前 Session 中压入新调用帧并创建新 AgentInstance：

- background 来自 graph node 的调用输入。
- frames、scratch 和 Mechanism state 从新实例开始。
- 子图看不到父图 frames。
- 子图退出后弹出调用帧，恢复父图仍在执行的 graph node。

子图 GraphRunResult 被归约为父 graph node 的 NodeCompletion。父图是否把它写入长期工作记忆，仍由父 Edge 决定。

## Compose

compose 压入新调用帧，但复用父 AgentInstance。子图因此可见父 frames，并复用该实例的 Mechanism state。

进入 compose 前，Runtime 记录父 frames 的 baseIndex，形成 FrameSegmentScope。子图执行期间新增 frames 都属于这个临时段。

正常返回：

1. 读取临时帧段的冻结快照。
2. 将帧段与子图 GraphRunResult 交给调用点 fold。
3. fold 只返回 status/result，不能伪造父 graph node 身份。
4. Runtime 截断临时帧段并返回父级 NodeCompletion。

异常返回：

1. Runtime 截断 baseIndex 之后的 frames。
2. 同步截断 frame 与 NodeScope 对齐信息。
3. 恢复父调用帧，不留下半关闭内部历史。

Graph 自身的 goal 和 mechanisms 在 compose 调用帧内局部生效，退出后撤销。

## Delegate

delegate 通过业务提供的 host factory 创建一次性独立 host。请求包含 background、调用来源、delegate 边界和取消信号。

host 生命周期固定为：

```text
create host → run graph → abort（如外层取消）→ dispose
```

新 Session 中安装 runtime-only LoopGraph adapter，创建新的 AgentInstance，并显式传入工具、renderer、limits、Mechanism 配置和 compaction 策略。外层只接收 GraphRunResult。

dispose 在成功和失败路径都必须执行。run 与 dispose 同时失败时，主运行错误保持为主因，清理错误作为附加诊断。

## 父节点恢复

父 graph node 在子图运行期间仍是逻辑上的活动节点。子调用帧弹出后，Runtime 必须从新的栈顶恢复：

- currentNode
- currentInput
- currentScope
- isNodeActive

否则投影层会误认为父节点已经结束，或把子图 scope 当成父级 scope。

## GraphCallScope

call/compose 复用 Session，因此子图 transcript 会进入同一消息流。Runtime 为每次共享调用写入配对 start/end 控制消息，并使用稳定 callId 匹配。

调用结束后，投影层持续删除整个闭合区段。end 消息必须位于 finally 路径，确保 Entry 不匹配、节点错误、Router/migrate/fold 错误也能闭合边界。

## 工具恢复

节点进入前保存当前 active tools，再按 node/default/toolResolver 计算当前工具集。节点退出的 finally 恢复先前工具集。

子图、Mechanism 或节点错误不能让临时工具配置泄漏到父节点或普通 Session。

## 取消与清理顺序

节点级 finally 的关键顺序是：

1. 停止 NodeContext 使用当前 Mechanism lifecycle。
2. 消费并清除当前 scope 的延迟控制失败。
3. 关闭 Mechanism invocation group，abort 后按 LIFO cleanup。
4. 恢复进入节点前的工具集。

图级 finally 在共享调用上发送 call_end，并在最内层保证 popGraph。root executeGraph 最终 reset Runtime、NodeContext、默认工具与活动引用。

## Compaction 边界

root-only 图可以推进自身 projectedFrameBase。活动 call/compose 不能允许 compaction 跨 GraphCallScope，因为原生 summary 无法区分父子 transcript。

delegate 使用独立 Session，可以拥有自己的 compaction 生命周期。

## 失败不变量

- 任一 pushGraph 最终对应 popGraph。
- 任一 call_start 最终对应 call_end。
- 任一 compose frame segment 最终归约或回滚。
- 任一节点工具切换最终恢复。
- 任一 Mechanism invocation group 最终关闭。
- 父节点身份在子图返回后恢复。
- delegate host 最终 dispose。
- 基础设施错误不得伪装为业务成功结果。

## 主要代码与测试入口

- `src/runtime.ts`：callStack、FrameSegmentScope、节点身份恢复。
- `src/adapter/loop-graph-extension.ts`：统一 runGraphLoop 和共享 Session 边界。
- `src/adapter/graph-execution-host.ts`：delegate host 生命周期。
- `src/adapter/isolated-graph-session.ts`：runtime-only 独立 Session。
- `src/adapter/characterization.test.ts`：多次 Agent run 与调用行为。
- `src/adapter/graph-execution-host.test.ts`、spike tests：delegate 隔离和清理。

