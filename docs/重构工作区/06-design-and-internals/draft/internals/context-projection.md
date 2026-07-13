# 内部协议：模型上下文投影与恢复

> 维护者文档。本文描述当前投影安全不变量，不属于普通 SDK 使用者的必读路径。

## 目标

pi Session 中同时存在外层对话、历史图调用、当前节点、Agent ReAct、工具结果和 compaction summary。投影层必须只向当前 Agent 暴露能够证明属于当前工作范围的内容，同时允许业务定制模型可见载荷。

核心原则是“载荷可定制，归属不可伪造”。

## 投影流水线

每次 context 事件先执行两层处理：

```text
原始 Session messages
→ 清除已闭合 GraphCallScope 区段
→ 根据当前 NodeScope 投影节点上下文
→ 动态加入仍需投影的 frames
→ 返回模型可见 messages
```

已闭合图调用的清洗始终执行，即使当前没有活动图；节点级投影只在 Runtime 有活动节点时执行。

## NodeScope：证明当前节点消息归属

每次节点访问都有独立 NodeScopeDescriptor，至少区分 graph run、AgentInstance、Graph、Node、visit 和调用深度。Runtime 向 Session 写入一个固定 customType 的 scope 锚点，并把结构化身份放在 details 中。

正文不能作为身份依据：业务内容可能伪造相同文本，renderer 也可以返回空正文。投影只信任受控 details 中完全匹配的 scopeId。

同一 scopeId 若因恢复等原因出现多次，使用最后一个匹配锚点，避免重新暴露旧区段。

## Renderer 的边界

contextRenderer 在节点进入时接收不共享 Runtime 可变引用的只读业务快照。它可以定义：

- 当前节点锚点的模型可见内容。
- skill 和额外说明的顺序与内容。
- 是否隐藏全部 SDK 合成正文。

SDK 复制并冻结 renderer 结果。即使 renderer 返回 null，也必须写入正文为空的 NodeScope 锚点，以维持可证明的消息边界。

renderer 不能读取或返回完整 transcript，也不能设置 scope identity、customType、details 或触发额外 turn。

## Frame 动态投影

已完成 frames 不永久编码在 node-enter renderer 结果中。投影时读取当前 projectedFrames，再交给 frameFormatter 生成模型载荷。

这样 compaction 在同一节点访问期间推进 frame baseline 后，已由 summary 覆盖的旧 frames 不会因复用冻结 renderer 结果而再次出现。

Frame 内容是开放业务载荷。默认 JSON 表达只是兼容行为；投影层不得假设 frame 存在 nodeId、status、summary 或 result。

## 正常路径

找到当前 NodeScope 锚点时：

1. 保留当前需要投影的 frames。
2. 从最后一个匹配锚点开始保留消息。
3. 丢弃锚点之前无法证明属于当前节点的 transcript。

NodeScope 之后的 Agent turn 和工具消息因此保持可见，而前一节点或外层会话内容被排除。

## Scope 缺失时的 fail-closed 恢复

锚点可能因 compaction、异常恢复或 Session 条目变化而缺失。此时不能回退到全部原始 transcript。

恢复策略是：

1. 重新使用节点进入时保存的冻结 renderer 结果；若不存在，则构造最小确定性 CURRENT。
2. 动态投影仍未被 summary 覆盖的 frames。
3. 仅恢复带 SDK 固定 scope details 且匹配当前 scope 的 Mechanism 消息。
4. 丢弃无法证明归属的 prompt、ReAct 和工具消息。

这会损失部分上下文，但优先保证不跨节点泄漏。

## Compaction 与 frame baseline

pi 原生 compaction summary 和 recent messages 是被压缩历史的权威替代。Runtime 不生成第二份摘要，也不重新发送锚点遮挡原生 summary。

Runtime 根据 compaction 切点和 frame 对应的 NodeScope 记录推进 projectedFrameBase：

- 完整落入压缩前缀的 frames 不再单独投影。
- 切点内部节点的 frame 仍保留，避免信息丢失。
- 完整 frames 仍留在 Runtime 中；baseline 只影响模型投影。
- baseline 只能单调前进。

若活动 scope 仍在 recent messages 中，保留 summary 和 scope 后消息。若 scope 已被压缩，先保留 summary，再恢复冻结 CURRENT 和 recent messages；其中其他 scope 的 Mechanism 消息必须过滤。

## GraphCallScope 清洗

共享 Session 的 call/compose 会产生子图 NodeScope、prompt、ReAct 和工具消息。进入时写入 call_start，离开时无论成功失败都写入匹配 callId 的 call_end。

投影从尾部匹配 start/end，并删除全部已闭合区段。未闭合调用仍处于活动状态，因此暂时保留。

调用区段的身份同样来自受控 details，而不是正文标签。

## 嵌套调用与 compaction

pi compaction 基于原始 Session entries，而不是 SDK 清洗后的投影。如果 compaction 跨越活动 call/compose，summary 可能同时包含父图和子图内部内容，事后无法可靠拆分。

因此：

- root-only 图允许正常 compaction。
- 活动 call/compose 期间，session_before_compact 必须取消压缩。
- 若取消被竞态或外部 extension 绕过，Runtime 标记边界违规、过滤可能污染的 summary，并终止共享调用，保持 fail closed。
- 需要独立压缩生命周期的长任务应使用 delegate。

## 结构化 Mechanism 上下文

`ctx.context.append()` 只能发送 SDK 定义的文本或图片块。SDK 固定 customType、display、details 和非 triggerTurn 选项，并在 details 中写入当前 scopeId。

投影正常时，这些消息随 NodeScope 后区段保留；scope 缺失时，只恢复 scopeId 完全匹配的消息。Mechanism 无法借此伪造 NodeScope 或额外 Agent turn。

## 不变量检查清单

- 身份匹配只读取受控 details。
- renderer 返回 null 仍保留空锚点。
- scope missing 不回退原始 transcript。
- frameFormatter 不改变 frame baseline。
- 已闭合 GraphCallScope 在所有后续 context 事件中持续删除。
- 活动共享调用不允许 compaction 穿越。
- delegate transcript 不进入外层 Session。
- Mechanism 结构化消息按 scopeId 恢复。
- Runtime 控制元数据不写入业务 frame。

## 主要代码与测试入口

- `src/adapter/projection.ts`：纯投影与 GraphCallScope 清洗。
- `src/adapter/loop-graph-extension.ts`：scope 消息、renderer 冻结、compaction 事件协调。
- `src/runtime.ts`：scope 身份、frame 对齐和投影 baseline。
- `src/adapter/projection.test.ts`：匹配、缺失恢复和结构化消息隔离。
- `src/adapter/compaction-frame.test.ts`：baseline 与共享调用 fail-closed。

