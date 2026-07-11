---
status: accepted
---

# 显式区分组合、调用与委托三种图调用边界

图可以被用户命令、agent 工具或父图调用，但入口不应决定执行语义。我们将 AgentSession 定义为物理执行边界、AgentInstance 定义为逻辑活动身份，并显式区分三种图调用：`compose` 复用 Session/Instance、共享父帧前缀并在退出时强制把新增帧段折叠为一个父级帧；`call` 复用 Session 但创建新 Instance，只交换参数与结果；`delegate` 创建新 Session 和新 Instance，同样只交换参数与结果。命令与工具必须统一映射到 GraphRunRequest/GraphRunResult，区别仅限展示适配。

保留 `call` 解决低开销的函数式隔离，增加 `compose` 支持“图代替点”的软件工程复用，使用 `delegate` 承担强隔离、并行与多 agent 外包。frames 作为模型可见的逻辑工作栈允许结构化帧段归约；完整不可变历史由独立 trace/audit 承担。现有 `kind: "graph"` 默认维持 `call`，避免破坏当前成果。

`compose` 的帧段归约策略属于调用点：同一张 Graph 在不同父图中可以选择不同的信息保留方式。Runtime 必须记录帧段基线、在正常返回时调用调用点的 fold 策略、在任何退出路径截断内部帧段；fold 只返回 status/result，节点身份由 Runtime 固定为父 graph node，默认行为只透传子图最终结果，显式策略可以完整编码帧段。父 Edge 仍负责把 graph node 的 NodeCompletion 折叠为父级 ContextFrame。

共享 Session 的 `call/compose` 还使用 GraphCallScope start/end 清理已闭合调用区段。pi compaction 基于原始 session entries，而不是 SDK 投影后的消息；一旦压缩跨越活动调用边界，生成的 summary 可能混合父上下文和子图内部 transcript，事后无法可靠拆分。因此活动的嵌套 `call/compose` 会取消 compaction，root-only 图仍可使用 NodeScope checkpoint；需要长时间运行和独立 compaction 生命周期的工作应选择 `delegate`。若取消策略异常失效，不以重发 call_start 作为恢复手段，而是终止共享调用并过滤已污染的 compactionSummary，保持 fail-closed。
