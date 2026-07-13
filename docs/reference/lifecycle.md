# 生命周期参考

本文描述 Loop Graph SDK 从图启动到节点退出全过程的执行顺序，覆盖节点的每个生命周期阶段以及机制 Hook 的触发时机。

---

## 图级生命周期

```text
graph_start
  → [node_enter → node_exit] × N
  → graph_end / graph_error
```

一次完整的图运行包含三个阶段：

1. **初始化**：Runtime 执行入口选择（`Entry.guard`），确定起始节点。
2. **循环**：每个节点完整执行一次（进入 → 执行 → 退出 → 路由），直到某条边指向 `END` 或超过最大步数。
3. **终止**：正常终止触发 `graph_end`，异常终止触发 `graph_error`。

---

## 节点生命周期

```text
node_enter
  → [onNodeEnter (串行)]
  → [beforeAgentRun]
  → LLM turn 循环:
      → onTurnStart
      → beforeToolCall → [工具开始 → onToolStart] → afterToolResult → onToolResult
      → onTurnEnd
  → [validateCompletion] × N
  → [onNodeExit]
  → node_exit
  → scope 关闭（逆序 cleanup + 取消事件订阅）
```

### 各阶段详细说明

| 阶段 | 说明 | 失败处理 |
| --- | --- | --- |
| `node_enter` | Runtime 分配新的当前节点执行周期（scope）、设置工具白名单、追加上下文消息。 | — |
| `onNodeEnter` | 全局和节点级机制串行执行。 | 抛错记日志并继续。`failurePolicy: "fail-node/fail-graph"` 可中断节点。 |
| `beforeAgentRun` | 每次 `runAgent()` 前调用。接收只读请求快照。 | 见 failurePolicy。 |
| LLM turn 循环 | LLM 推理、调用工具、接收结果，反复进行直到调用 `__graph_complete__`。 | — |
| `onTurnStart` / `onTurnEnd` | 每个 LLM turn 前后的事件观察点。 | 见 failurePolicy。 |
| `onToolStart` / `beforeToolCall` / `afterToolResult` / `onToolResult` | 工具生命周期各阶段的观察与拦截点。 | `beforeToolCall` 可 deny/patch；`afterToolResult` 可 replace。 |
| `validateCompletion` | `__graph_complete__` 状态为 `ok` 时触发。代码侧验证（`outputSchema` → `validateCompletion`）先于机制层验证。 | reject → 驳回重试；fail-node → 节点失败；fail-graph → 图终止。 |
| `onNodeExit` | 节点主体完成、边选择之前串行执行。接收完成信号只读快照。 | 见 failurePolicy。 |
| 路由与迁移 | Runtime 选择边、执行 `edge.migrate` 并保存工作记忆。 | 无匹配边时以当前完成状态结束。 |
| `node_exit` | 路由与迁移完成后发出节点退出事件。 | — |
| scope 关闭 | 取消信号触发、逆序执行 cleanup、取消事件订阅。 | cleanup 抛错不阻止其他 cleanup。 |

### 异常路径

当节点异常没有被 `fail-node` 转换成失败完成信号时：

```text
onNodeError（观察原始错误，不能替换）
  → scope 关闭（逆序 cleanup + 取消事件订阅）
  → 异常进入图错误路径（graph_error）
```

---

## Agent Run 生命周期

`ctx.runAgent(prompt)` 的内部生命周期：

```text
beforeAgentRun
  → output contract（配置 outputSchema 时）
  → [LLM turn] × N
      → onTurnStart
      → [工具调用] × N
          → beforeToolCall
          → 工具执行开始 → onToolStart
          → afterToolResult → onToolResult
      → onTurnEnd
  → __graph_complete__ 完成提交
  → 校验链（outputSchema → runAgent 验证 → Node 验证 → 机制验证 → agent-choice）
      → rejected：本次工具结果直接说明原因，Agent 可再次提交
      → accepted：生成 NodeCompletion
  → 返回 NodeCompletion
```

- 每次 `runAgent()` 分配独立 `agentRunId`，事件不会串到上一轮。
- `outputSchema` 的完整、确定性 JSON Schema 在首个 turn 前展示给模型；过大或不可序列化时 Agent Run 在启动前失败，不会截断。
- 校验驳回原因直接作为本次 `__graph_complete__` 的工具结果返回，不再额外注入一条重试消息。
- Agent 提交的 `status/result` 不会被 SDK 回显；工具结果和默认 UI 只展示 Runtime 的接受、拒绝或失败决定。
- `traceSink` 会收到契约准备、提交、各验证阶段开始及最终决定事件；事件只含指纹、大小、阶段、耗时和原因等安全摘要，不含完整 schema 或业务结果。
- Agent 超时返回 `status: "failed"`；主动取消或其他不可恢复情况的具体状态由完成路径决定。

---

## 工具调用生命周期

```text
LLM 发起工具调用
  → beforeToolCall（按机制注册顺序依次执行）
      → deny → 拒绝调用，reason 告知 LLM
      → patch → 修改参数（需通过 schema 校验）
      → allow → 放行
  → 工具执行开始
  → onToolStart（只读观察）
  → afterToolResult（按顺序依次执行）
      → replace → 替换 LLM 可见的内容
      → keep → 保留原结果
  → onToolResult（只读观察）
```

规则：
- `__graph_complete__` 不经过 `beforeToolCall` 的一般补丁流程。
- `beforeToolCall` 的 patch 按机制顺序组合并重新校验参数 schema。无可靠 schema 时拒绝 patch。
- `afterToolResult` 只能替换 `content` 和 `isError`，不能修改元数据。

---

## 校验链顺序

```text
outputSchema
  → runAgent 级 validateCompletion
  → Node.validateCompletion
  → 机制 validateCompletion（按注册顺序）
  → agent-choice 校验器（机制验证之后执行）
```

每层校验失败时后续层不执行。全部通过后节点进入路由选择。Agent 报告 `failed` 或 `cancelled` 时跳过这条成功校验链，并形成相应终态完成信号。

---

## Cleanup 顺序

1. scope 取消信号触发（`AbortController.abort()`）。
2. 按注册逆序（LIFO）执行 `onCleanup` 注册的清理函数。
3. 每个 cleanup 抛错不阻止后续 cleanup，也不覆盖原始错误。
4. `ctx.events` 订阅自动 dispose（幂等）。

---

## 子图边界对生命周期的影响

| 边界 | Session | AgentInstance | 事件 | cleanup |
| --- | --- | --- | --- | --- |
| `call` | 复用 | 新建 | 独立 scope | 子图退出时清理 |
| `compose` | 复用 | 复用 | 每个节点仍有独立执行周期；机制 state 复用 | 子图退出时归约后继续 |
| `delegate` | 新建 | 新建 | 完全独立 | 由 delegate host 管理 |

---

## 上下文压缩交互

1. 独立图：pi 的 `session_compact` 事件触发后，SDK 推进帧投影基线。压缩前的帧不再重复出现，不重发节点指引。
2. 嵌套 call/compose 活跃期间：SDK 阻止 pi 压缩（`session_before_compact` 返回 `cancel: true`），避免父上下文与子图内部对话混合。
3. 如果阻止失败（竞态或第三方 extension 绕过），SDK 标记边界违规、终止共享调用、过滤压缩摘要。

---

## 相关链接

- [核心类型与工厂 API](api.md)
- [错误与限制](errors-and-limits.md) — failurePolicy 的详细行为
- [配置项参考](configuration.md) — limits 和 mechanismRuntime
