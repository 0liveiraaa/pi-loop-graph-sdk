# 错误与运行限制

## GraphRunResult

`GraphRunResult<TOutput>` 是判别联合：

- `{ status: "completed", output: TOutput }` — 成功
- `{ status: "failed", failure: GraphFailure }` — 失败
- `{ status: "cancelled", failure: GraphFailure & { code: "cancelled" } }` — 取消

所有分支共享：`rootRunId`、`graphId`、`graphVersion`、`steps`、`durationMs`、`replay`。

## 稳定 failure code

| code | 含义 |
|------|------|
| `invalid-graph` | 图结构无效（缺少 Stage、重复 Connection 等） |
| `invalid-input` | 输入不匹配 schema |
| `entry-not-found` | 无 Entry guard 匹配 |
| `tool-unavailable` | 需要的工具在 Host 中不存在 |
| `host-unavailable` | Host 能力缺失（如缺少 runAgent） |
| `agent-timeout` | Agent 超时 |
| `agent-ended-without-completion` | Agent 结束但未提交 completion |
| `validation-exhausted` | 3 次拒绝后仍未通过验证 |
| `max-steps-exceeded` | 超过步数/预算限制 |
| `no-route` | 无 Connection guard 匹配 |
| `transition-failed` | Transition 执行失败 |
| `mechanism-failed` | Mechanism hook 控制失败 |
| `persistence-failed` | recordingRequired 时录制失败 |
| `resume-incompatible` | checkpoint 版本不匹配 |
| `runtime-error` | 未分类运行时错误 |
| `cancelled` | 被 signal 取消 |

每个 `GraphFailure` 还包含 `phase`、`retryable` 和可选的 `stageId`：

```typescript
interface GraphFailure {
  code: GraphFailureCode;
  phase: "root" | "graph" | "entry" | "node" | "agent" | "route" | "transition" | "host";
  message: string;
  retryable: boolean;
  stageId?: string;
  cause?: unknown;
}
```

## 调用预算

| 限制 | 默认值 | 说明 |
|------|--------|------|
| maxGraphDepth | 8 | 最大嵌套深度 |
| maxGraphInvocations | 64 | 最大图调用数 |
| maxTotalNodeVisits | 500 | 最大节点访问数 |

delegate 传播用量。超过限制 → `max-steps-exceeded`。

## 并发限制

一个 Host 同时只允许一个 Root Run。并发需创建独立 Host。

## 完成重试

每次 Agent Run 默认最多 3 次拒绝。Agent Node、Code Node 和 Host 只能逐层收紧。

## 上下文预算

sticky 上下文超过 `maxStickyContextBytes`（默认 256KB）时，Agent Run 前返回 `runtime-error`。

## Mechanism 失败策略

| failurePolicy | 行为 |
|---------------|------|
| `"continue"`（默认） | 记录后继续 |
| `"fail-node"` | 节点失败 |
| `"fail-graph"` | 图终止 |

控制 Hook（beforeAgentRun、validateCompletion）默认为 fail-closed。观察 Hook 默认记录后继续。

## 相关文档

- [生命周期](lifecycle.md) — 执行顺序
- [配置项](configuration.md) — limits 配置
- [API 参考](api.md) — 类型签名
