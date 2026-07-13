# ADR 漂移审查

本文件记录任务 06 对现有 ADR 的只读审查。根据用户要求，本任务不修改正式 `docs/adr/`；最终收口时可按以下建议做最小修订。

## ADR-0001：图调用边界

结论：核心决策仍有效，与当前 call/compose/delegate 行为一致。

建议修订：

- “delegate 承担强隔离、并行与多 agent 外包”容易被理解为 SDK 已提供并行编排。建议改为“delegate 提供可由外部 host 用于隔离或并发承载的物理边界；当前图运行仍串行等待结果”。
- “完整不可变历史由独立 trace/audit 承担”当前只有 lifecycle traceSink，并非完整事件溯源。建议改为“不把完整历史塞入 frames；审计能力由外部 traceSink 承担”。
- 其他关于 compose frame segment、GraphCallScope 和 compaction fail-closed 的描述仍准确。

## ADR-0002：安全 Context Renderer

结论：核心决策仍有效。

仍准确的部分：

- renderer 只定制模型载荷，不接管完整消息数组。
- NodeScope 匹配、GraphCallScope 清洗、scope missing fail-closed、compaction summary 和 frame baseline 由 SDK 固定。
- renderer null 仍保留空锚点。
- frames 继续由 frameFormatter 动态投影。
- delegate 不隐式继承调用级 renderer。

建议补充：

- Mechanism `ctx.context.append()` 已支持带固定 scope details 的文本/图片块；scope missing 与 compaction recovery 会按 scopeId 过滤。
- 新增内容属于现有安全边界的延伸，不需要新 ADR。

## ADR-0003：Completion 与 Skill

结论：固定 completion ABI 和 skill 来源决策仍有效，但校验顺序已漂移，需要修订。

当前 ADR 写的是：

```text
outputSchema → runAgent validator → Node validator → agent-choice validator
```

当前实现是：

```text
outputSchema
→ runAgent validator
→ Node validator
→ Mechanism completion gate
→ agent-choice validator
```

并且 validator/gate 现在支持异步、timeout、取消、重复 completion 去重和并发保护。Mechanism gate 可产生与 Agent result 分离的 verifiedResult。

建议最小修订上述顺序及异步 gate 事实，不改变 ADR 标题和固定 ABI 决策。

## 是否需要新增 ADR

本次不建议新增 ADR。

- Mechanism broker 的单 listener 是上游 pi 无 off 所导致的实现策略，可在 internals 说明。
- logger/traceSink、formatToolResult、toolResolver 是可逆公共扩展点，不满足“难以逆转”的条件。
- 多 Agent 通讯仍是研究提案，尚未形成真实取舍和接受决策。

