# 错误处理与运行限制

本文说明 Loop Graph SDK 的错误策略、超时机制、运行限制和并发约束。

---

## 机制失败策略（failurePolicy）

机制（Mechanism）的 Hook 在抛错时的处理由 `failurePolicy` 控制：

| `failurePolicy` | Hook 抛错后的行为 | 适用场景 |
| --- | --- | --- |
| `"continue"`（默认） | 记录日志并继续正常流程。 | 纯观测性 hook（日志、审计、监控）。 |
| `"fail-node"` | 框架生成可信失败完成信号，跳过节点主体执行，直接交给路由。 | 节点进入条件不满足、轻量校验失败。 |
| `"fail-graph"` | 终止整个图，但 `onNodeError` 和全部 cleanup 仍会执行。 | 安全边界被突破、验收基础设施异常。 |

### 多机制冲突时的优先级

同一阶段多个机制发生控制性失败时，全部 Hook 仍按顺序执行，最终按最高严重程度决定行为：

```text
fail-graph > fail-node > continue
```

例如：三个机制在同一生命周期，一个抛错且 `failurePolicy: "fail-node"`，另一个抛错且 `failurePolicy: "fail-graph"` → 最终图终止。

### 各 Hook 的失败策略覆盖

| 阶段 | 适用 failurePolicy |
| --- | --- |
| `createState` | ✅（初始化失败会按该机制的 failurePolicy 处理，依赖无效 state 的 Hook 不再执行） |
| `onNodeEnter` | ✅ |
| `beforeAgentRun` | ✅ |
| `onTurnStart` / `onTurnEnd` | ✅ |
| `onToolStart` / `onToolResult` | ✅ |
| `beforeToolCall` / `afterToolResult` | ✅ |
| `validateCompletion` | ✅（此外还有 reject / allow / fail-node / fail-graph 的显式决策） |
| `onNodeExit` | ✅ |
| `onNodeError` | ❌（自身抛错仅作为次级诊断，不改变失败策略） |
| cleanup | ❌（抛错不阻止其他 cleanup，不覆盖原始错误） |

---

## 运行限制

### LoopGraphLimits

```typescript
interface LoopGraphLimits {
  rootMaxSteps?: number;        // 默认 100
  childMaxSteps?: number;       // 默认 50
  agentRunTimeoutMs?: number;   // 默认 300000 (5 分钟)
  completionValidationTimeoutMs?: number;  // 默认 60000 (1 分钟)
}
```

| 限制 | 默认值 | 触发时行为 |
| --- | --- | --- |
| `rootMaxSteps` | 100 | root 图超过步数后返回 `failed`，`result.reason` 包含 "Max steps (N) exceeded" |
| `childMaxSteps` | 50 | call/compose 子图超过步数后返回 `failed`，错误传播到父图 |
| `agentRunTimeoutMs` | 300 秒 | `ctx.runAgent()` 超时后返回 `status: "failed"`，result 中说明超时 |
| `completionValidationTimeoutMs` | 60 秒 | `validateCompletion`（包括机制层）等待超时后抛出错误，受 failurePolicy 控制 |

所有值必须在 `createLoopGraphExtension()` 时是有限正整数，否则立即报错。

---

## 并发限制

| 场景 | 是否允许 | 说明 |
| --- | --- | --- |
| 同一 `LoopGraphExtension` 实例多次 `executeGraph()` | ❌ 立即报错 | 内部 `rootRunActive` 标记阻止 |
| 同一 pi Session 创建多个 extension 实例 | 不构成并发方案 | 事件不隔离 |
| 图内部嵌套 `call`/`compose` | ✅（串行） | 子图执行期间父节点等待 |
| delegate 边界的子图 | ✅（隔离 host，但仍串行等待） | 父图等待 delegate 完成后继续；这不是图内并行分支 |

需要并发时，为每个任务创建独立的 delegate host（独立 Session）。

---

## 图校验错误

### 抛出异常与失败返回值

`executeGraph()` 启动执行前发生的错误会直接抛出，包括同一实例并发调用、图结构校验失败和工具存在性校验失败。调用方应使用 `try/catch` 处理这些配置或调用错误。

进入图循环后，大多数运行异常会被扩展捕获并转换为 `GraphRunResult`，其 `status` 为 `"failed"`、`result.reason` 包含原因。调用方因此还必须检查返回状态，不能只依赖 `catch`。

### 图结构校验（validateGraph）

`executeGraph` 调用时自动执行，校验：
- 图 ID 非空
- 节点 ID 在 `nodes` 和 `routing` 中一致
- code 节点提供 `execute`，graph 节点提供 `graph`
- 边 `from`/`to` 指向存在的节点或 `END`
- `fold` 只允许用于 compose；compose 省略时使用默认归约，call/delegate 不能提供
- delegate 边界时 `createDelegateHost` 已配置

校验失败直接 throw，不进入执行。

### 工具存在性校验（validateGraphTools）

首次执行时自动校验，之后缓存结果：
- 节点声明的所有 `tools` 是否在 pi 中已注册
- 通过 `resolveNodeTools` 解析后的工具集内的工具是否都可用

校验失败 throw，不进入执行。

---

## 无边匹配

当节点的路由中所有边的 `guard` 都返回 `false` 时：

- 图优雅结束（不 throw）。
- Runtime 当前会推入一条包含兼容字段的说明帧；该结构不是公共最佳实践，不应作为业务契约读取。
- 返回的 `GraphRunResult.status` 沿用 `NodeCompletion.status`。

---

## 上下文压缩边界违规

嵌套 `call`/`compose` 活跃期间，SDK 阻止 pi 的上下文压缩。如果阻止失败（竞态或第三方绕过）：

1. `sessionCompactionBoundaryViolated` 设为 `true`。
2. 后续 Session 的上下文投影持续过滤 `compactionSummary`。
3. 继续运行时 `assertNoCompactionBoundaryViolation()` 会抛出错误终止图。

---

## 常见错误排查

| 错误现象 | 可能原因 | 排查步骤 |
| --- | --- | --- |
| "同一 instance 不支持并发" | 试图同时调用两次 `executeGraph` | 确保前一次完全结束再启动下一次；并发用 delegate |
| "图请求 delegate 但未配置 createDelegateHost" | graph node 使用 `boundary: "delegate"` 但未提供 host 工厂 | 配置 `createDelegateHost` 或改用 `call`/`compose` |
| "节点未找到" | routing 或 edge 引用了不存在的节点 | 检查 `routing` 中的 `nodeId` 与 `nodes` key 是否一致 |
| "无匹配入口" | 所有 Entry 的 guard 返回 false | 检查 `background` 内容和 Entry guard 条件 |
| "Max steps exceeded" | 图或子图超过最大步数 | 检查是否有自环没出口；增大 `rootMaxSteps`/`childMaxSteps` |
| Agent 不退出 | `validateCompletion` 持续驳回或 LLM 不调 `__graph_complete__` | 通过 `node_enter` 定位节点，再查看 pi 会话中 `__graph_complete__` 返回的修正原因；公开 trace 暂无 `agent_retry` 事件 |
| 工具校验失败 | 节点声明的工具未在 pi 中注册 | 在注册图之前注册对应 extension 提供的工具 |

---

## 相关链接

- [核心类型与工厂 API](api.md)
- [配置项参考](configuration.md) — limits 和 mechanismRuntime 的完整说明
- [生命周期](lifecycle.md) — failurePolicy 在每个阶段的触发时机
