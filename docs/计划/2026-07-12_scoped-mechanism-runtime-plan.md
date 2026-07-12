# 作用域化 Mechanism 与 Agent Hook Runtime 实施计划

> 状态：proposed  
> 日期：2026-07-12  
> 范围：单 Agent Loop Graph SDK 的 Mechanism 生命周期、节点 Agent Hook、安全能力与兼容迁移  
> 不包含：多 Agent 通讯协议、任意 Runtime 控制面修改、一次性补齐所有 pi 事件

## 实施进度

- Phase 0：已完成（2026-07-12）——冻结裸 `ctx.pi.on()` 的非托管累积语义，修正文档中的天然隔离承诺与机制组合顺序。
- Phase 1：已完成（2026-07-12）——每个 mechanism/node visit 独立 scope、AbortSignal、active 检查、LIFO cleanup、scope-aware append，以及正常/异常/call/compose/runtime-only delegate 回归。
- Phase 2–9：待实施。

## 一、结论

审查的主结论成立：当前 Mechanism 适合作为“节点进入前、必须在 await 内完成的状态或上下文预处理”，不适合作为长期事件监听、资源锁、事务、安全门禁或通用横切机制系统。

代码核对确认了三个高优先级问题：

1. `ExtensionAPI.on()` 返回 `void`，pi 没有取消订阅接口。每次 node visit 直接调用 `ctx.pi.on()` 会永久积累监听器。
2. `appendContext()` 只是 `pi.sendMessage()` 闭包，没有核对创建它的 `scopeId`。延迟回调可能在后续节点追加消息。
3. 节点执行异常时没有 visit 级 cleanup；现有 `runtime.exitNode()` 只在路由成功或无匹配边的正常路径调用。

因此，本计划采用“双层能力面”：保留完整 `ctx.pi` 作为正式支持但不受托管的逃生口，同时引入由 NodeScope 约束的 **Mechanism Invocation** 和安全 Hook Runtime。开发者可以获得完整 pi 可定制能力，也可以选择由 SDK 保证作用域、清理、组合和取消语义的安全工具。

目标不是限制 Mechanism 只能做简单预处理，而是让它在不接管图骨架的前提下，具备支持权限门禁、工具审计、自动验收、资源生命周期、上下文增强和运行观测的充分表达空间。

## 二、对审查意见的校正

| 审查意见 | 核对结论 | 计划处理 |
| --- | --- | --- |
| Graph mechanism → Node mechanism | 不完整。当前实际顺序为 `AgentInstance.mechanisms → 当前 CallFrame.localMechanisms → Node.mechanisms` | 保持现有确定顺序并写入文档 |
| pi 没有 off | 成立，类型中 `on(...): void` | 使用单次注册的事件转发器，不伪造 unsubscribe |
| appendContext 天然隔离 | 文档承诺不成立，代码无 active scope 检查 | 改为 scope-aware append，失效后返回 `false` |
| scratch 无命名空间 | 成立 | 增加 mechanism-local state，兼容保留 legacy scratch |
| 需要 priority/before/after/dependsOn | 是扩展性需求，但不是当前正确性前置条件 | P2 再评估；P0 保持数组顺序，避免引入依赖图复杂度 |
| appendContext 应支持任意自定义消息 | 方向成立，但不可开放 NodeScope 控制字段 | P1 开放受限结构化内容，不开放任意 customType/details |
| 需要 graph/tool/turn/compaction 全生命周期 hook | 需求合理，但一次全部加入会扩大不稳定表面积 | 先完成 node enter/exit/error 和少量 scoped events |
| 是否保留完整 `ctx.pi` | 保留，作为非托管逃生口，不降级、不删除 | SDK 保证可访问性，不为其副作用提供 NodeScope 安全承诺 |

## 三、核心模型

### 3.1 Mechanism 与 Mechanism Invocation 分离

- **Mechanism**：可复用定义，声明名称、失败策略和生命周期回调。
- **Mechanism Invocation**：某个 mechanism 在某个 NodeScope/visit 上的一次运行，拥有独立 signal、cleanup 和事件订阅。
- **Mechanism state**：按 `AgentInstance + mechanism 定义身份` 隔离，可跨该实例内的多个 node visit 保留；不进入模型上下文。
- **Invocation resources**：只属于当前 visit，节点关闭后必须失效并清理，不能放进长期 state。

建议公共形态：

```ts
type MechanismFailurePolicy = "continue" | "fail-node" | "fail-graph";

interface Mechanism<TState = Record<string, unknown>> {
  name: string;
  failurePolicy?: MechanismFailurePolicy;
  createState?(): TState;
  onNodeEnter?(ctx: MechanismContext<TState>): void | Promise<void>;
  beforeAgentRun?(ctx: AgentRunHookContext<TState>): MaybePromise<AgentRunPatch | void>;
  onTurnStart?(ctx: TurnHookContext<TState>): MaybePromise<void>;
  onTurnEnd?(ctx: TurnEndHookContext<TState>): MaybePromise<void>;
  beforeToolCall?(ctx: ToolCallHookContext<TState>): MaybePromise<ToolCallDecision | void>;
  afterToolResult?(ctx: ToolResultHookContext<TState>): MaybePromise<ToolResultDecision | void>;
  validateCompletion?(ctx: CompletionHookContext<TState>): MaybePromise<CompletionDecision>;
  onNodeExit?(ctx: MechanismExitContext<TState>): void | Promise<void>;
  onNodeError?(ctx: MechanismErrorContext<TState>): void | Promise<void>;
}

interface MechanismScope {
  readonly scopeId: string;
  readonly visit: number;
  readonly signal: AbortSignal;
  isActive(): boolean;
  onCleanup(cleanup: () => void | Promise<void>): void;
}
```

这组 Hook 分为三类，权限不能混用：

| 类别 | 能力 | 典型 Hook |
| --- | --- | --- |
| 观察 Hook | 读取只读快照、写私有 state/telemetry，不改变运行结果 | `onTurnStart/onTurnEnd/onNodeExit` |
| 决策 Hook | 返回 SDK 定义的有限决定，由 Runtime 校验并应用 | `beforeToolCall/afterToolResult/validateCompletion` |
| 效果能力 | 在 scope、timeout 和输出预算内产生外部效果 | `context.append/exec.run/onCleanup` |

### 3.2 节点 Agent Hook 生命周期

单次 node visit 内的完整 Hook 顺序定义为：

```text
onNodeEnter
→ beforeAgentRun
→ [onTurnStart
   → beforeToolCall
   → tool execution
   → afterToolResult
   → onTurnEnd] × N
→ validateCompletion × N（可驳回并继续 agent）
→ onNodeExit
→ scope close / cleanup
```

任意阶段出现未被失败策略吸收的异常时：

```text
onNodeError
→ scope close / cleanup
→ fail-node 或 fail-graph
```

不是所有 code node 都会调用 `runAgent()`。纯代码节点仍只有 node enter/exit/error 生命周期；agent/turn/tool/completion Hook 只在该节点实际调用 `ctx.runAgent()` 时触发。

同一节点内多次调用 `runAgent()` 时，共享同一个 node invocation 和 mechanism state，但每次 agent run 有独立 `agentRunId`，防止上一轮 turn/tool 事件误归属到下一轮。

### 3.3 事件订阅采用 Extension 级转发器

Extension 创建时对每类支持的 pi 事件最多注册一次监听器。监听器将事件转发给当前活跃 invocation 的订阅记录：

```text
pi tool_result
    ↓ 唯一底层监听器
MechanismEventBroker
    ↓ 只选择 active scope
当前 invocation handlers
```

`ctx.events.onToolResult(handler)` 返回 SDK 自己的 disposable。dispose 的含义是从 broker 的订阅表移除，而不是调用不存在的 `pi.off()`。

第一批只支持已经有明确需求且不会修改控制流的观察事件：

- `tool_result`
- `turn_start`
- `turn_end`

`tool_call` 和 `tool_result` 的决策能力在生命周期基础稳定后接入同一 broker。provider、compaction 和 session 事件延后，因为它们影响整个 Session，而不天然属于单个 NodeScope。

### 3.4 双层能力面：安全工具与完整 ctx.pi

新 `MechanismContext` 同时提供两类能力。

安全、受 Runtime 托管的能力：

- `scope`
- `state`
- `context.append(...)`
- `events`
- `exec.run(...)`
- `telemetry.record(...)`
- 当前 `instance/node/input` 的既有访问

完整自由能力：

- `ctx.pi: ExtensionAPI`

`ctx.pi` 不是 deprecated API，也不计划删除或通过开关禁用。它保持与 pi 原生 `ExtensionAPI` 相同的完整能力，适合安全工具尚未覆盖的高级定制。

但 `ctx.pi` 属于 **非托管能力**。契约明确如下：

| SDK 保证 | SDK 不保证 |
| --- | --- |
| `ctx.pi` 存在且保持完整 ExtensionAPI 类型 | `ctx.pi.on()` 注册的 handler 会随节点退出移除 |
| awaited hook 内抛出的错误仍进入 mechanism failure policy | 延迟 callback/后台 Promise 的错误会被 Runtime 捕获 |
| Runtime 自己的 NodeScope/call boundary 仍维持内部不变量 | 裸 `sendMessage/sendUserMessage` 具备 scope 隔离或 recovery 复用 |
| 节点结束时 Runtime 仍恢复自己管理的 active tools | 裸 `setActiveTools()` 的结果能越过 Runtime 恢复逻辑持续生效 |
| pi 原生 API 按上游语义工作 | 注册的工具、命令、provider 或事件只在当前 node visit 生效 |
| SDK 文档说明已知交互边界 | 多个裸 pi handler 与安全 Hook 具有可预测的组合顺序 |

使用裸 pi 后产生的 session 级监听器、全局注册、额外 turn、system prompt 变化、工具集变化和模型切换，由机制作者自行设计生命周期与冲突处理。SDK 可以记录开发模式诊断，但不得阻止调用或偷偷改变其结果。

推荐文档和内置机制优先展示安全 API；高级章节单独展示 `ctx.pi`，并明确每个示例的资源所有权和清理责任。这是“推荐路径”差异，不是权限差异。

Mechanism 不得通过安全 API 修改：

- Runtime 当前 node、call stack、frames 或 NodeScope 身份；
- Edge/Router 结果；
- `call/compose/delegate` 边界；
- 最终 active tools；
- system prompt。

机制作者可以通过 `ctx.pi` 触及上述 pi 能力，但一旦这样做，对应行为退出安全 Hook Runtime 的保证范围。SDK 不把这种使用视为违规，也不承诺它与图控制面语义兼容。

其中 `exec.run()` 是对 pi `exec()` 的受控包装：

- 自动绑定 `scope.signal`；
- 必须声明 timeout，或使用 Extension 默认 timeout；
- 限制 stdout/stderr 最大字节数；
- 返回复制、冻结的结果；
- scope 关闭时取消子进程；
- 不允许 mechanism 自行绕过工作目录和命令策略。

### 3.5 Tool Hook 决策与组合

pi 原生 `tool_call` 允许原地修改 `event.input`，且修改后不重新校验。Mechanism API 不直接暴露这个可变对象，而是提供只读调用快照并返回决定：

```ts
type ToolCallDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "patch"; input: Readonly<Record<string, unknown>> };
```

组合规则固定为：

1. 按 instance → call-frame local → node 顺序串行执行。
2. 每个 `patch` 作用于上一个机制的结果，但机制只能看到复制快照。
3. 任意 `deny` 立即停止后续决策 Hook，并阻止工具执行。
4. 所有 patch 完成后，由 SDK 对最终输入重新执行可用的工具 schema/安全校验；无法校验时默认只允许 `allow/deny`，禁止 patch。
5. `__graph_complete__` 不走一般工具参数 patch；其固定 ABI 由 completion 管线管理。

`afterToolResult` 可以保留结果、替换模型可见 content、标记错误或附加受控反馈，但不得修改 Runtime 私有 details、toolCallId 或伪造另一个工具结果。

### 3.6 Completion Hook 与可信自动验收

`validateCompletion` 是异步决策 Hook，在 AI 调用 `__graph_complete__` 并结束当前 agent turn 后、节点真正放行前执行：

```ts
type CompletionDecision =
  | { action: "allow"; verifiedResult?: Readonly<Record<string, unknown>> }
  | { action: "reject"; reason: string }
  | { action: "fail-node"; reason: string }
  | { action: "fail-graph"; reason: string };
```

校验顺序扩展为：

```text
outputSchema
→ runAgent validateCompletion
→ Node.validateCompletion
→ Mechanism completion hooks
→ agent-choice
```

Mechanism completion hooks 按机制顺序串行执行，任一 `reject` 即停止后续检查并触发 agent retry。`verifiedResult` 由 Runtime 放入独立可信字段，不与 AI 自报 result 浅合并，避免同名覆盖。

典型自动验收：

```ts
async validateCompletion(ctx) {
  const test = await ctx.exec.run("npm", ["test", "--", "--run"], {
    timeoutMs: 120_000,
  });
  return test.code === 0
    ? { action: "allow", verifiedResult: parseTestSummary(test.stdout) }
    : { action: "reject", reason: summarizeTestFailure(test) };
}
```

相同 completion 在同一 agent run 内只验收一次。是否按工作区版本缓存跨 retry 的结果属于后续优化，不进入首版。

### 3.7 NodeScope 关闭契约

每个 node visit 创建一个 invocation group。无论以下哪条路径发生，都在 visit 的 `finally` 中关闭：

- 正常 completion、路由和 migration；
- 无匹配边结束；
- node execute 抛错；
- mechanism hook 抛错；
- router/migrate/fold 抛错；
- max-step、graph abort 或父调用回滚。

关闭顺序固定为：

```text
完成 onNodeExit 或 onNodeError
→ 标记 scope inactive
→ abort signal
→ 逆序执行 cleanup
→ 从 event broker 移除订阅
→ 恢复工具和上层 Runtime 状态
```

`context.append()` 必须同时检查 invocation active 和 Runtime 当前 `scopeId`。失效后返回 `false`，不得发送消息或抛出普通竞态错误。

## 四、失败语义

P0 支持三种策略：

| 策略 | 行为 |
| --- | --- |
| `continue` | 记录错误并继续；保持当前兼容默认值 |
| `fail-node` | 跳过或终止节点主体，生成 `status: "failed"` 的可信 completion，继续交给 Router/Edge |
| `fail-graph` | 抛出机制失败错误，终止当前图调用，并执行所有 cleanup |

暂不实现 mechanism 自身 retry。跨阶段重试应优先通过图回路表达；基础设施瞬时重试可由 mechanism 在自身 awaited hook 内完成。

`onNodeError` 默认仅观察原始错误，不允许替换错误或把失败改成成功，避免机制绕过图控制流。

## 五、分阶段实施

### Phase 0：冻结现状与危险用法（P0，约 0.5 天）

目标：在改 Runtime 前建立可复现证据并修正文档漂移。

- 增加 characterization tests：循环访问导致监听器累积、延迟 append 污染后继节点、execute 异常无 cleanup。
- 修正 `src/type.ts` 和开发者指南中“天然隔离”的错误承诺；将直接 `ctx.pi.on()` 归入非托管高级用法并说明永久监听风险。
- 明确当前机制组合顺序：instance → call-frame local → node。
- 将现有 Mechanism 标记为“双层能力面尚未完成”，不削弱 `ctx.pi` 的现有能力。

验收：测试能稳定暴露现有风险；文档不再承诺代码尚未提供的隔离能力。

### Phase 1：InvocationScope 与统一 cleanup（P0，约 1 天）

目标：先解决生命周期正确性，不引入事件 API。

- 新增内部 `MechanismInvocationScope`/group，绑定 `NodeScopeDescriptor`。
- 为每个 visit 创建 `AbortController`、active 标记和 LIFO cleanup 栈。
- `MechanismContext` 增加 `scope.signal/isActive/onCleanup`。
- `appendContext` 改为 scope-aware，返回 `boolean`。
- 将 node visit 主体包入严格 `try/catch/finally`，覆盖 execute、router、migrate、子图异常。
- cleanup 自身异常聚合记录，不阻止其他 cleanup 执行；若已有主错误，不覆盖主错误。

验收：旧 visit 的 timer/promise 回调无法写入新 NodeScope；所有正常、异常、call/compose/delegate 路径恰好 cleanup 一次。

### Phase 2：安全事件转发器（P0，约 1 天）

目标：允许跨 turn 观察，但不积累 pi 监听器。

- Extension 创建时建立 `MechanismEventBroker`。
- 每类底层 pi event 只注册一次。
- 新增 `ctx.events.onToolResult/onTurnStart/onTurnEnd`，返回 disposable。
- scope close 自动移除全部订阅；handler 执行前再次检查 active。
- 定义 handler 错误策略：事件 handler 错误进入所属 mechanism 的 failure policy；避免未处理 Promise rejection。
- 明确事件分发顺序与机制组合顺序一致，默认串行，防止共享 state 竞态。

验收：节点循环 20 次后一次事件只命中当前 visit；关闭后的 handler 永不执行；底层监听器数量恒定。

### Phase 3：生命周期 hook 与失败策略（P0/P1，约 1 天）

目标：形成最小但完整的节点生命周期。

- 增加 `onNodeExit` 和 `onNodeError`。
- 增加 `continue/fail-node/fail-graph`。
- `onNodeExit` 接收只读 completion 快照；`onNodeError` 接收只读错误上下文。
- 定义多 mechanism 失败组合：按顺序执行；首个控制性失败为主因，其余作为附加诊断。
- `fail-node` 产生由 Runtime 写入的失败信息，不信任 mechanism 自行伪造 nodeId。

验收：三种策略分别覆盖 enter/exit/error/event handler；Router 能接收 fail-node completion；fail-graph 仍完整清理。

### Phase 4：机制私有 state（P1，约 0.5–1 天）

目标：消除 scratch 键冲突，同时保留实例级持久语义。

- 使用 Runtime 私有存储按 `AgentInstance + mechanism 对象身份` 建立 state。
- 支持 `createState()` 懒初始化，每个实例每个定义一次。
- `ctx.state` 提供类型化访问。
- 保留 `instance.scratch` 兼容，但标记为 legacy shared namespace；不自动迁移或复制用户数据。
- call/delegate 的新 instance 获得新 state；compose 复用 instance，但不同 mechanism 定义保持隔离。

验收：同名 mechanism 对象、不同 mechanism 对象、call/compose/delegate 的状态边界均有测试。

### Phase 5：Agent run、turn 与工具观察 Hook（P1，约 1 天）

目标：让机制完整观察节点中 Agent 的工作过程，但暂不改变工具行为。

- 将 `PiNodeContext.runAgent()` 的 runId 与当前 mechanism invocation 关联。
- 增加 `beforeAgentRun/onTurnStart/onTurnEnd`。
- 增加只读 `onToolStart/onToolResult` 观察 Hook；事件快照去除 live 引用并冻结。
- 同一节点多次 `runAgent()` 时按 agentRunId 隔离事件。
- 为观察 Hook 增加输出预算，禁止把完整超大工具结果隐式写入 state/上下文。

验收：多 turn、多工具、多次 runAgent、晚到事件和嵌套 call/compose 均归属正确。

### Phase 6：工具决策 Hook 与受控执行能力（P1，约 1–1.5 天）

目标：支持权限门禁、参数约束、结果脱敏和节点级外部命令。

- 增加 `beforeToolCall` 的 allow/deny/patch 管线。
- 增加 `afterToolResult` 的受限结果变换管线。
- 对 patch 后输入重新校验；不能安全校验的工具禁止 patch。
- 增加 `ctx.exec.run()`，绑定 signal、timeout、cwd policy 和输出截断。
- 记录每个机制的决策 trace，便于解释工具为何被阻止或修改。
- 明确与其他 pi extension handler 的边界：SDK 只保证自身 mechanism 之间的确定组合，不能控制外部 extension 的注册顺序。

验收：deny 不执行工具；patch 后参数经过校验；结果脱敏不破坏 Runtime details；abort 能终止命令。

### Phase 7：异步 Completion Gate 与可信验收（P1，约 1–1.5 天）

目标：让 `__graph_complete__` 触发真实、异步、可取消的自动验收。

- 将 completion 校验管线升级为 async，保持现有同步 validator 兼容。
- 接入 Mechanism `validateCompletion` Hook。
- 支持 allow/reject/fail-node/fail-graph。
- `reject` 复用现有模型 retry 回路；验收期间节点不得提前 resolve。
- 将可信结果保存为 Runtime 生成的 `verifiedResult`，与 AI result 分离。
- 增加验收 timeout、取消、输出摘要、重复 completion 去重和并发保护。
- 默认只对 `status: "ok"` 执行 gate；failed/cancelled 保持现有退出语义。

验收：真实命令退出码决定放行；AI 伪造测试数量无效；失败反馈能触发下一轮且不会产生并发 agent turn。

### Phase 8：受限结构化上下文与兼容收口（P1，约 1 天）

目标：与现有模型上下文 renderer 对齐，但不开放投影控制面。

- `context.append()` 支持文本和 SDK 定义的内容块（文本/图片能力按 pi 实际类型开放）。
- SDK 固定 `customType/details/display/triggerTurn`，Mechanism 不能伪造 NodeScope 或触发额外 turn。
- 延迟内容仍必须在 active scope 内显式 append，不提供隐式后台渲染。
- 内置与入门示例优先迁移到 `scope/state/context/events`；增加独立的裸 `ctx.pi` 高级章节。
- `ctx.pi` 保持完整且默认可用，不加入权限开关；可选开发诊断只提示风险，不阻断执行。

验收：结构化内容参与正常 projection、scope missing recovery 和 compaction recovery 时不会跨 scope 泄漏。

### Phase 9：可选扩展（P2，另行决策）

只有出现真实机制库需求后再评估：

- priority/before/after/dependsOn 与冲突检测；
- graph start/end、compaction、provider 等高权限事件；
- mechanism 去重规则；
- 并行 handler；
- 基于工作区版本或输入摘要的验收缓存；
- Hook 执行预算、熔断和机制级可观测面板；
- 为常见裸 pi 模式提供更多可选安全包装，但不以删除裸 `ctx.pi` 为目标。

## 六、主要代码落点

| 文件 | 预期改动 |
| --- | --- |
| `src/type.ts` | 新 Mechanism、scope、state、events、Hook decision、failure policy 公共类型 |
| `src/runtime.ts` | invocation/state 所有权或与 adapter 协作的 NodeScope 关闭接口 |
| `src/adapter/loop-graph-extension.ts` | visit try/finally、hook 分派、失败转换、broker 接线 |
| `src/adapter/mechanism-runtime.ts`（新增） | invocation group、event broker、cleanup/state 管理 |
| `src/adapter/mechanism-hooks.ts`（新增） | Hook 快照、决策组合、工具输入与结果管线 |
| `src/adapter/pi-node-context.ts` | agentRunId、异步 completion gate、retry/并发控制 |
| `src/adapter/projection.ts` | 验证结构化 mechanism 消息仍受 NodeScope 投影约束；尽量不改投影内核 |
| `src/index.ts` | 导出新增公共类型 |
| `src/adapter/loop-graph-extension.test.ts` | 生命周期、顺序、失败策略、循环与嵌套边界测试 |
| `src/adapter/isolated-graph-session.test.ts` | delegate Session 的 state/subscription/cleanup 隔离 |

## 七、全量验证矩阵

- 生命周期：正常、execute 抛错、router 抛错、migrate 抛错、max steps、abort。
- visit：同节点循环、多节点切换、旧异步回调晚到。
- 边界：root、call、compose、delegate、嵌套组合。
- 事件：订阅、手动 dispose、自动 dispose、handler 抛错、底层监听器恒定。
- Agent Hook：多次 runAgent、多 turn、工具并行/串行、晚到事件归属。
- 工具决策：allow/deny/patch、patch 校验、结果脱敏、机制冲突与外部 extension 边界。
- 自动验收：异步 allow/reject、timeout、abort、重复 completion、可信结果、AI 伪造字段。
- 顺序：instance → call-frame local → node；hook 和 cleanup 的确定顺序。
- state：同定义跨 visit、不同定义隔离、新 instance 隔离、compose 复用。
- 上下文：失效 append 返回 false；不触发 turn；不伪造 NodeScope；compaction 后不泄漏。
- 兼容：旧 `onNodeEnter(ctx.pi/instance.scratch/appendContext)` 代码仍能编译运行；`ctx.pi` 不产生弃用错误。
- 基线：全量测试、typecheck、`git diff --check`、真实 LLM spike。

## 八、风险与控制

1. **NodeScope 与 invocation 关闭顺序不一致**：以单个 visit `finally` 为唯一关闭入口，禁止多个分支自行 cleanup。
2. **pi 事件返回值冲突**：P0 broker 只开放观察型事件；可修改行为的事件另做 ADR。
3. **cleanup 卡死**：cleanup 支持同步/异步但需要独立超时预算；超时记录后继续剩余 cleanup。
4. **裸 pi 副作用被误认为受托管**：保留完整能力，但通过类型注释、文档分区、诊断 trace 明确“可用不等于自动隔离”。
5. **fail-node 破坏路由语义**：统一生成标准 failed completion，仍由既有 Router/Edge 决定后续路径。
6. **工具参数 patch 绕过 schema**：只对可重新校验的工具开放 patch；其他工具仅允许 allow/deny。
7. **自动验收触发重复 turn**：completion gate 由单一 active run 状态机串行处理，验收完成前不 resolve、不触发第二个 retry。
8. **机制获取过多敏感输出**：事件和 exec 结果使用复制快照、字节预算和可配置脱敏器。

## 九、工作量估算

- 安全生命周期基础（Phase 0–3）：约 3.5–4.5 个开发日。
- state 与观察 Hook（Phase 4–5）：约 1.5–2 个开发日。
- 工具决策与受控执行（Phase 6）：约 1–1.5 个开发日。
- 异步自动验收（Phase 7）：约 1–1.5 个开发日。
- 结构化上下文和兼容收口（Phase 8）：约 1 个开发日。
- 合计：约 7–10 个开发日，包含测试、文档和真实 LLM spike。

如果只修复最高风险而不开放 scoped events，可先实施 Phase 0–1，约 1.5 天；这会解决延迟 append 和 cleanup，但不能安全支持长期工具/turn 监听。

## 十、完成定义

达到以下条件后，才能把 Mechanism 从“受限 node-enter callback”提升为“安全且具有充分表达空间的节点 Agent Hook Runtime”：

- 每个 node visit 有可观察、可取消、必清理的 invocation 生命周期；
- 失效 invocation 无法向后续 NodeScope 写消息；
- 事件监听不会随循环次数增长；
- Agent run、turn、tool 和 completion 有明确、类型化且可组合的 Hook；
- 工具门禁和参数变换不暴露可变 pi event，也不会绕过校验；
- `__graph_complete__` 可以触发异步可信验收，AI 自报字段不能决定放行；
- 外部命令受 scope signal、timeout、cwd 和输出预算约束；
- `ctx.pi` 继续提供完整 ExtensionAPI，不被权限开关、删减类型或自动代理限制；
- 安全 API 与裸 pi 的责任边界有明确文档，使用者可以主动选择便利与托管程度；
- 必要机制可以明确阻止节点或图继续；
- mechanism state 不再依赖共享 scratch 键名；
- call/compose/delegate 的所有权与隔离行为有测试和文档；
- 旧 API 有明确迁移路径。
