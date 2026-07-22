---
status: superseded
superseded_by: "Phase 6 — __graph_complete__ accepts { result } only; old status ABI removed"
---

# 固定 completion 控制 ABI，在 Runtime 校验业务结果并开放 skill 内容来源

`__graph_complete__` 的工具名以及 `ok/failed/cancelled` 状态继续作为 Runtime 固定 ABI。不同 Agent Run 的业务结果结构不通过动态替换工具 parameters 实现：同一个 pi Session 只注册一次完成工具，按活动运行改写全局工具 schema 会造成多实例冲突。`AgentRunRequest.outputSchema` 因此成为单次 Agent Run 的输出契约：Runtime 在首个 turn 前向模型展示完整、确定性序列化的 JSON Schema，并使用同一份规范化 schema 编译 validator。schema 不可稳定序列化或超过预算时在启动前失败，绝不截断。

Agent 的工具参数定义为不可信的 `CompletionSubmission`，不等于 `NodeCompletion`。状态为 `ok` 时，完成校验顺序固定为 outputSchema、当前 `runAgent()` validator、Node validator、Mechanism validator、agent-choice validator；前一层失败时后续层不执行，只有 Runtime 接受后才生成 `NodeCompletion`。Agent 报告 `failed/cancelled` 时允许形成终态，并跳过只针对成功结果的校验链。

完成校验发生在 `__graph_complete__` 的 `tool_result` 阶段，拒绝原因直接作为该次工具结果返回，不再等待 `agent_end` 或注入额外 retry 消息。SDK 不回显 Agent 填写的 `status/result`，默认 UI 也隐藏原始调用参数，只展示 Runtime 决策。完成反馈可通过 `completionFeedbackFormatter` 定制；formatter 只接收节点 ID 与受信任决策，返回的 details 同样替换为 Runtime 决策。

`node.skill` 仍是单引用，但内容来源开放为异步 `SkillContentProvider`，展示开放为同步 `SkillContentRenderer`。默认 provider 保持 `skillBasePath/{ref}/SKILL.md`，默认 renderer 保持 `[skill: ref]` 包装。provider/renderer 只接收不共享 Runtime 引用的只读快照。缺失与加载错误分别配置 `ignore` 或 `fail`；自定义 renderer 接管 skill 展示时，默认 CURRENT 不再重复暴露内部 skill ref。
