---
status: accepted
---

# 固定 completion 控制 ABI，在 Runtime 校验业务结果并开放 skill 内容来源

`__graph_complete__` 的工具名以及 `ok/failed/cancelled` 状态继续作为 Runtime 固定 ABI。不同节点的业务结果结构不通过动态替换工具 parameters 实现：同一个 pi Session 只注册一次完成工具，按活动节点改写全局工具 schema 会造成多实例冲突。`AgentRunRequest.outputSchema` 因此在 Runtime 捕获 completion 后校验，不通过时复用现有 retry 回路。

完成校验顺序固定为 outputSchema、当前 `runAgent()` validator、Node validator、agent-choice validator。前一层失败时后续层不执行。Node validator 由 Runtime 在执行有效节点前显式安装到 `PiNodeContext`，不再依赖业务代码重复传入。

模型恢复文案与 completion tool result 文本可以定制，但不得修改 completion details 和控制状态。validation retry、incomplete、dead-run、graph failure 使用 `ModelMessageFormatter`；完成工具的模型反馈使用 `completionToolResultFormatter`，通过 `tool_result` patch 修改 content，原 details 保持不变。

`node.skill` 仍是单引用，但内容来源开放为异步 `SkillContentProvider`，展示开放为同步 `SkillContentRenderer`。默认 provider 保持 `skillBasePath/{ref}/SKILL.md`，默认 renderer 保持 `[skill: ref]` 包装。provider/renderer 只接收不共享 Runtime 引用的只读快照。缺失与加载错误分别配置 `ignore` 或 `fail`；自定义 renderer 接管 skill 展示时，默认 CURRENT 不再重复暴露内部 skill ref。
