# Loop Graph SDK 领域语言

本文件只定义项目中的稳定术语和概念边界。使用方法、公共类型、实现协议和未来设想分别属于指南、参考文档、内部文档和研究文档。

## 图与执行流程

**回路图（Loop Graph / Graph）**：
由入口、节点、边和路由规则组成的可执行任务流程；它允许通过边返回先前阶段，以显式表达跨阶段迭代。
_Avoid_: 工作流链、DAG、Skill 文档、ReAct 循环

**图调用（Graph Invocation）**：
使用一组明确输入启动一张图并取得稳定业务结果的一次请求。
_Avoid_: 节点进入、工具调用、会话启动

**入口（Entry）**：
图对一次调用输入的匹配规则，以及匹配成功后选择的第一个节点。
_Avoid_: START 节点、起始边、虚拟完成信号

**节点（Node）**：
图中的一个可执行工作阶段；它可以运行普通代码、驱动 Agent，或调用另一张图。
_Avoid_: 节点会话、Prompt 模板、路由器

**节点访问（Node Visit）**：
工作实例从进入某个节点到离开该节点的一次完整经历；同一节点可以因图上的循环被访问多次。
_Avoid_: AgentSession、永久节点状态

**进入序号（Visit）**：
同一图运行中某个节点访问的顺序编号，主要用于区分重复进入和辅助诊断。
_Avoid_: 重试次数、Agent turn、图步骤总数

**Agent 运行（Agent Run）**：
节点在一次访问中发起的一段 Agent 工作；一次节点访问可以依次发起多次 Agent 运行。
_Avoid_: 节点访问、图调用、单个 turn

**完成信号（Node Completion）**：
节点对外提交的状态和业务结果，供路由与迁移判断当前阶段如何结束。
_Avoid_: 工作记忆帧、图返回、Agent 自由文本

**边（Edge）**：
从一个节点到下一节点或图终点的迁移规则；它判断完成信号是否适用，并声明要留下的工作记忆和后继输入。
_Avoid_: 普通连线、路由器、节点执行逻辑

**路由器（Router）**：
在一个节点可用的边中选择至多一条迁移路径的规则。
_Avoid_: 调度器、节点、Edge guard

**图终点（END）**：
表示图合法结束的专用目标，不是一个可执行节点。
_Avoid_: 结束节点、失败状态、无匹配边

**图结果（Graph Run Result）**：
一次图调用对外返回的图身份、状态、业务结果和步骤数；它不包含内部工作记忆或 Agent 对话轨迹。
_Avoid_: Node Completion、ContextFrame、执行日志

## 工作身份、会话与数据

**逻辑工作实例（Agent Instance）**：
在图中移动的一份逻辑工作身份，持有总体目标、已完成工作记忆和横切扩展状态。
_Avoid_: AgentSession、模型客户端、全局单例

**执行会话（Execution Session / AgentSession）**：
承载模型、消息流、工具和上下文压缩的物理运行环境；它与逻辑工作实例是两个不同边界。
_Avoid_: Agent Instance、图运行结果、节点访问

**图背景（Background）**：
图调用开始时提供给整张图的稳定输入背景。
_Avoid_: 节点输入、工作记忆、Mechanism state

**节点输入（Node Input）**：
某次节点访问收到的一次性业务输入，来自图入口或上一条边。
_Avoid_: 图背景、跨节点持久状态、模型对话历史

**工作记忆帧（Context Frame）**：
一个已完成阶段明确留给后续阶段的业务记忆；其内容由图作者定义，不具有固定业务字段。
_Avoid_: Node Completion、完整 ReAct 轨迹、固定 summary/result 结构

**模型上下文（Model Context）**：
当前 Agent 运行实际可见的信息集合，包括当前任务说明和仍需保留的工作记忆。
_Avoid_: AgentInstance 的全部字段、Runtime 内部状态、原始完整 transcript

**横切状态（Mechanism State）**：
某个横切扩展在同一逻辑工作实例内保留的私有代码侧状态；它不属于模型上下文，也不用于迁移业务数据。
_Avoid_: Context Frame、Node Input、共享业务数据库

**可信验收结果（Verified Result）**：
由受控验收过程产生、与 Agent 自报业务结果分离保存的可信检查结论。
_Avoid_: Agent 自报 result、Node Completion 状态、日志摘要

## 图调用边界

**图调用边界（Graph Invocation Boundary）**：
调用另一张图时，对执行会话、逻辑工作实例和工作记忆共享关系的明确选择。
_Avoid_: 图入口来源、命令模式、工具模式

**组合（Compose）**：
被调用图复用当前执行会话和逻辑工作实例，并在返回前把其临时工作记忆归约为调用方的一次阶段结果。
_Avoid_: Call、Delegate、无边界内联

**调用（Call）**：
被调用图复用当前执行会话，但使用新的逻辑工作实例；双方只通过明确输入和最终结果交换业务数据。
_Avoid_: Compose、共享工作记忆子图

**委托（Delegate）**：
被调用图使用新的执行会话和新的逻辑工作实例，形成最强的运行隔离。
_Avoid_: 普通子图、同会话调用、并行分支本身

**帧段（Frame Segment）**：
组合调用期间形成的一段临时工作记忆；组合结束时必须整体归约或回滚。
_Avoid_: 永久父级历史、子 AgentInstance、普通数组切片

## 横切扩展

**横切扩展（Mechanism）**：
围绕节点工作过程提供观察、约束、验收或受控外部能力的可复用定义；它不选择下一节点，也不迁移业务状态。
_Avoid_: Router、Node executor、中间件总线、隐式业务流程

**横切扩展调用（Mechanism Invocation）**：
某个横切扩展在一次节点访问中的临时运行身份，其资源随该次访问结束。
_Avoid_: Mechanism 定义、跨节点后台任务、永久事件监听器

**节点执行周期（Mechanism Scope / Scope）**：
横切扩展在一次节点访问中可以安全产生作用的有效生命周期；访问结束后，该周期内的订阅、取消和清理关系同时失效。
_Avoid_: AgentSession、GraphCallScope、业务权限范围

**观察 Hook（Observation Hook）**：
读取节点、Agent、turn 或工具生命周期信息，但不直接改变被观察行为结果的接入点。
_Avoid_: 决策 Hook、裸事件监听器、Router guard

**决策 Hook（Decision Hook）**：
通过有限、明确的决定允许、拒绝或受控修改某个 Agent 行为的接入点。
_Avoid_: 任意对象修改、完整 Runtime 控制、Edge 迁移

**托管能力（Managed Capability）**：
由 SDK 约束生命周期、取消、输出边界或组合顺序的 Mechanism 能力。
_Avoid_: 裸 pi 能力、全局副作用、无所有者后台任务

**非托管能力（Unmanaged Capability / `ctx.pi`）**：
横切扩展直接使用底层 pi API 的完整能力；其副作用、资源所有权和冲突处理由扩展作者承担。
_Avoid_: 自动获得节点周期安全保证的 API

## 当前范围边界

**串行 Agent 编排（Serial Agent Orchestration）**：
同一图运行在任一时刻只推进一条节点路径，节点及其 Agent 运行按确定顺序完成。
_Avoid_: fork/join、并行分支、多 Agent 调度

**多 Agent 通讯（Multi-Agent Communication）**：
多个独立 Agent 之间的寻址、消息交换和共享协作模型；它是未来研究方向，不属于当前 SDK 的能力承诺。
_Avoid_: Mechanism events、子图调用、delegate 隔离

**会话恢复（Session Resume）**：
在进程或会话结束后恢复未完成图运行及其工作记忆的能力；它不属于当前 SDK 的能力承诺。
_Avoid_: compaction、同一运行内的子图返回、节点循环
