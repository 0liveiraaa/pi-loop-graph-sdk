---
status: accepted
---

# 显式区分组合、调用与委托三种图调用边界

图可以被用户命令、agent 工具或父图调用，但入口不应决定执行语义。我们将 AgentSession 定义为物理执行边界、AgentInstance 定义为逻辑活动身份，并显式区分三种图调用：`compose` 复用 Session/Instance、共享父帧前缀并在退出时强制把新增帧段折叠为一个父级帧；`call` 复用 Session 但创建新 Instance，只交换参数与结果；`delegate` 创建新 Session 和新 Instance，同样只交换参数与结果。命令与工具必须统一映射到 GraphRunRequest/GraphRunResult，区别仅限展示适配。

保留 `call` 解决低开销的函数式隔离，增加 `compose` 支持“图代替点”的软件工程复用，使用 `delegate` 承担强隔离、并行与多 agent 外包。frames 作为模型可见的逻辑工作栈允许结构化帧段归约；完整不可变历史由独立 trace/audit 承担。现有 `kind: "graph"` 默认维持 `call`，避免破坏当前成果。
