# 任务 00：术语与事实基线

> 状态：工作区草稿已完成（2026-07-13），等待最终迁移
> 当前交付：`docs/重构工作区/00-glossary-and-truth/CONTEXT.md`
> 最终目标：`docs/设计/CONTEXT.md`

## 目标

建立后续全部文档共同使用的简洁术语表，并清除当前 `CONTEXT.md` 中的实现细节、过时字段和未实现能力。此任务是其他文档任务的前置依赖。

## 修改范围

- 主要修改：`docs/设计/CONTEXT.md`
- 可新增：`docs/concepts/glossary.md`，如果决定将外部术语表与设计上下文分开。
- 不修改 README、开发者指南或 Runtime 代码。

## 必须核对的漂移

- Node 不会为每次进入创建新的 AgentSession；不要再称为“节点会话”。
- `NodeCompletion` 当前没有 `agentHint`。
- 当前是单 Agent 串行编排；通讯、QoS、共享状态和多 Agent 寻址未实现。
- AgentInstance 是逻辑工作身份和工作记忆，不是 pi AgentSession。
- frame 是开发者定义的后续工作记忆，兼容字段不是固定 schema。
- Router 无匹配边时当前会优雅结束，不存在文档中描述的自动诊断图配置。
- Mechanism 私有 state 不是跨节点业务状态通道。

## 推荐规范术语

| 中文首称 | API/英文名 | 面向用户的解释 |
| --- | --- | --- |
| 回路图 | Graph | 可循环的阶段编排图 |
| 节点 | Node | 一个可执行工作阶段 |
| 完成信号 | NodeCompletion | 节点交给路由判断的结构化结果 |
| 边 | Edge | 保存当前阶段记忆并指向下一阶段的迁移规则 |
| 工作记忆帧 | ContextFrame | 已完成阶段留给后续阶段的记忆 |
| 逻辑工作实例 | AgentInstance | 一份目标、工作记忆和机制状态 |
| 执行会话 | AgentSession/Session | 承载模型、消息、工具和压缩的物理会话 |
| 横切扩展 | Mechanism | 围绕节点执行过程工作的 Hook 与安全能力 |
| 节点执行周期 | scope | 一次进入节点到退出节点的有效生命周期 |
| 进入序号 | visit | 节点在本次图运行中第几次被进入，仅高级诊断使用 |

## 输出要求

- 术语表只说明概念、边界和相邻概念差异。
- 删除路线图、具体字段清单、伪接口和未实现通讯协议。
- 每个词条控制在 2–6 个短段落。
- 为 `call/compose/delegate` 提供一个三行对比表。
- 明确列出“当前不支持”：并行分支、多 Agent 通讯、会话恢复。

## 验收

- 外部开发者读完后能区分 AgentInstance 与 Session。
- 搜索不到把 `agentHint` 当成现有字段的描述。
- 搜索不到把节点执行周期称为独立 AgentSession 的描述。
- 术语表中没有 Phase 编号和源码文件结构。
