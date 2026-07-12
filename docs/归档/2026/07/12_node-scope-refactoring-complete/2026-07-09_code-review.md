# 2026-07-09 代码审查记录

> 审查人开发注释搜集。三个发现。

---

## 1. 子图循环与主循环代码重复

**位置**：`src/adapter/loop-graph-extension.ts:518`

**现状**：`runSubgraphInExtension`（约 340-440 行）几乎是 `executeGraph` 主循环（190-300 行）的完整复制。差异仅在于子图用 `childRt`/`childNc`、调用栈深度 50 vs 100、完成时返回 `NodeCompletion` 而非 `sendMessage("图完成")`。

**建议**：抽出一个 `runGraphLoop(runtime, nodeContext, graph, background, maxSteps)` 通用函数，主图和子图都调它。子图额外做 finalFrame 归约。

**影响**：非阻塞。改动后代码量减半，主图和子图的行为保证一致。

---

## 2. agent-choice 降级策略：priority-first → 应改为重试

**位置**：`src/router.ts:37`

**现状**：`agent-choice` 路由在 agent 未声明边、或声明了不存在的边时，静默降级为 `priority-first`：

```typescript
case "agent-choice": {
  if (matched.length === 1) return matched[0];
  const chosenId = completion.result?.[field];
  if (typeof chosenId === "string") {
    const edge = matched.find((e) => e.id === chosenId);
    if (edge) return edge;
  }
  // 降级：agent 未声明或声明了不存在的边 → priority-first
  return priorityFirst(matched);
}
```

**问题**：降级让 agent 不知道自己选错了边，图静默走 priority-first——agent 的决策被无视。这和 completion 验证不通过时让 agent 重试的哲学不一致。

**建议方向**：改为返回错误信号给 agent 重试，而非降级。两种做法：
- A：`selectEdge` 拿到重试回调，在 agent 选边失败时注入 retry prompt
- B：运行时主循环检测 `router.kind === "agent-choice"` 且 `selectEdge` 返回 null，退出前向 agent 注入重试消息

---

## 3. type.ts scratch 注释残留声明式措辞

**位置**：`src/type.ts:74`

**现状**：`AgentInstance.scratch` 的文档注释写道「写了就是绕过声明式机制」。但机制已从 `check/apply` 声明式改为 `onNodeEnter` hook 式，措辞过时。

**建议**：删除该措辞。
