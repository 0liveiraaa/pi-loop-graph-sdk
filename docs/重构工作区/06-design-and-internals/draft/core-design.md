# Loop Graph SDK 核心设计

> 当前稳定设计的精简说明。术语以 `docs/设计/CONTEXT.md` 为准；具体 API 属于参考文档，Runtime 算法属于内部文档。

## 问题与定位

Agent 能在一次 ReAct 过程中调用工具并反复思考，但真实软件任务通常还包含更高层的阶段变化，例如：生成、检查、修改、再次检查。若这些阶段全部隐藏在一个 Prompt 中，流程难以测试、观察和复用。

Loop Graph SDK 将这种工作建模为可循环的有向图：节点完成一个阶段，边保存后续需要的工作记忆并指向下一阶段，路由器从可用路径中选择一条。节点内部的 ReAct 保持自由，跨阶段变化保持显式。

当前产品定位是单 Agent 串行编排 SDK：一次图运行只推进一条节点路径。它支持子图、代码与 Agent 混合节点、横切 Mechanism、工具门禁和可信完成验收，但不提供 fork/join、多 Agent 通讯或会话持久恢复。

## 核心心智模型

```text
图调用
  ↓
Entry → Node → NodeCompletion → Router → Edge → Node / END
          │                         │
          └── 节点内 ReAct          └── 跨阶段循环
```

### Graph 与 Entry

Graph 是任务的模块边界，持有目标、入口、节点和路由配置。Entry 只根据图调用背景选择第一个节点，不伪造 START 节点或完成信号。

### Node 与 NodeCompletion

Node 是一个工作阶段。code node 可以运行普通代码并按需驱动 Agent；graph node 把另一张图作为阶段实现。

节点只提交 NodeCompletion：状态、业务结果，以及可选的 Runtime 可信验收结果。它不决定下一节点，也不直接写入长期工作记忆。

### Edge 与 Router

Edge 判断某个完成信号是否适用，把当前阶段需要保留的信息折叠为 ContextFrame，并可生成下一节点的一次性输入。

Router 在满足条件的边中选择至多一条。业务重试和诊断路径应显式表达为图上的边；无匹配边时，图以当前完成状态和结果结束。

### END 与图结果

END 是合法终点而非节点。指向 END 的边仍可保存最后一帧工作记忆，并通过显式 output 定义稳定 GraphRunResult。普通图返回不携带内部 frames、ReAct 或 trace。

## 一次图执行的生命周期

1. 调用方提供 background、调用来源和边界。
2. Runtime 创建或复用逻辑工作实例，并压入当前图调用。
3. Entry 匹配 background，产生第一个 NodeInput。
4. Runtime 激活节点工具、上下文和 Mechanism。
5. Node 执行代码、Agent 或子图，最终提交 NodeCompletion。
6. 完成校验和 Mechanism gate 在节点真正放行前运行。
7. Router 选择 Edge；Edge 生成 ContextFrame、后继 NodeInput 或 END output。
8. Runtime 退出节点并继续下一步，或返回 GraphRunResult。
9. 所有路径都必须关闭节点周期、取消临时任务、执行 cleanup 并恢复上层状态。

节点可以多次调用 Agent；每次 Agent run 有独立身份，turn 和工具事件不能串到另一轮。图上的循环则会创建新的节点访问，用于表达跨阶段迭代。

## 上下文与状态边界

SDK 有四条主要数据通道：

| 数据 | 责任 |
| --- | --- |
| background | 一次图调用的稳定背景 |
| NodeInput | 某次节点访问的一次性输入 |
| ContextFrame | 显式留给后续阶段、通常模型可见的业务工作记忆 |
| Mechanism state | 不进入模型上下文的横切扩展私有状态 |

NodeCompletion 与 ContextFrame 必须分离：前者用于控制和路由，后者用于后续工作记忆。Frame 的内容完全由开发者定义；`nodeId/status/summary/result` 只是兼容字段，不是当前固定结构。

业务数据必须沿 Completion → Edge → Frame/NodeInput 显式迁移。Mechanism state 和 scratch 不能替代这条链。

模型上下文也不等于 Runtime 全部状态。renderer 可以定制当前节点说明和附加内容，frameFormatter 可以定制历史工作记忆的模型表达，但安全归属、调用隔离和压缩恢复仍由 SDK 控制。

## 子图调用边界

调用来源与调用边界互相独立。用户命令、Agent 工具和父图都可以选择合适边界。

| 边界 | Session | AgentInstance | 父 frames | 返回 |
| --- | --- | --- | --- | --- |
| call（默认） | 复用 | 新建 | 不可见 | 状态与结果 |
| compose | 复用 | 复用 | 可见 | 临时帧段归约后的状态与结果 |
| delegate | 新建 | 新建 | 不可见 | GraphRunResult |

call 是普通模块化子任务的默认选择。compose 用于“以图代点”：子图需要父级工作记忆，但内部帧在返回时必须归约或回滚。delegate 用于独立上下文压缩、长任务或强会话隔离，需要业务方提供独立执行 host。

共享 Session 的 call/compose 会产生内部对话。已闭合调用必须从父级模型上下文清除；活动嵌套调用不能让 compaction 跨越边界，否则混合摘要无法可靠拆分。

## Mechanism 的权限边界

Mechanism 是围绕节点工作的横切扩展，不是隐藏的流程引擎。它可以：

- 观察节点、Agent、turn 和工具生命周期。
- 对工具调用返回 allow、deny 或受控 patch。
- 脱敏模型可见的工具结果。
- 在 Agent 声称完成后执行可信验收。
- 管理节点周期内的取消、清理、事件和受控外部命令。
- 保存不进入模型上下文的实例级私有状态。

它不能通过托管 API 选择下一节点、修改调用边界、伪造 Runtime 身份或用私有 state 隐式迁移业务数据。

`ctx.pi` 保留完整底层能力，但属于非托管通道。由它产生的永久监听、额外 turn、全局工具变化和后台任务不自动获得节点周期的安全语义。

## 可信完成

`__graph_complete__` 的工具名和控制状态是固定 ABI。业务结果依次经过 output schema、run 级 validator、Node validator、Mechanism completion gate 和 agent-choice 检查。

Mechanism gate 可以放行、拒绝并让 Agent 继续、让节点失败或让图失败。真实命令产生的 verifiedResult 与 Agent 自报 result 分开保存，避免模型通过填写字段伪造验收结论。

## 扩展表面与可观测性

SDK 的扩展能力分为三层：

- 业务函数：Node execute、Edge guard/migrate、Router 和 compose fold，直接表达流程行为。
- 托管扩展：renderer、skill provider、Mechanism Hook、tool resolver 和 formatter，在固定安全边界内定制行为。
- 外围集成：delegate host、logger 和 traceSink，把执行连接到独立 Session、监控或审计系统。

扩展点不应获得超出其职责的 Runtime 引用。读取型输入优先使用复制冻结快照；能够改变控制结果的扩展必须返回有限决定，而不是修改 live 对象。

生命周期 trace 覆盖 graph start/end/error、node enter/exit 和 compaction。观测失败不能改变图控制流；文件输出默认关闭，仅在显式 debug 配置下启用。

工具解析、graph tool 结果格式化和模型消息文案都可以定制，但 SDK 始终保留框架工具、稳定 details 和 Runtime 控制身份。

## 安全与失败语义

业务失败与基础设施错误必须区分：

- NodeCompletion 和 GraphRunResult 的 failed/cancelled 是稳定业务结果。
- 工具缺失、host 创建失败、调用边界违规等基础设施问题以异常或可信 Runtime 失败报告。
- Mechanism fail-node 仍交给 Router/Edge，允许图显式建模补救路径。
- fail-graph 终止当前图调用，但不能跳过 finally、cleanup 或调用边界闭合。

安全恢复遵循保守原则：无法证明消息归属时丢弃内容；无法重新校验工具 patch 时拒绝 patch；验收系统异常时由显式 failurePolicy 决定是否继续、失败节点或失败整图。

默认限制包括最大图步骤、Agent run 超时、completion gate 超时、工具输出预算和受控 exec 目录。这些限制保护执行边界，不替代业务图自己的终止条件。

## 不可破坏的设计原则

1. 图编排阶段，节点内部完成 ReAct。
2. Node 只产出完成信号，Edge 承担业务记忆折叠和后继输入。
3. 跨阶段业务状态必须显式迁移。
4. AgentInstance 与 AgentSession 是两个独立边界。
5. 子图共享关系必须由 call、compose 或 delegate 明确声明。
6. Frame 是开放业务载荷，Runtime 控制元数据不进入 Frame。
7. renderer 只定制模型载荷，不接管完整 transcript 或安全投影。
8. scope 无法证明时 fail closed，不回退未经归属的原始消息。
9. completion 控制 ABI 固定，业务验收在 Runtime 中组合。
10. Mechanism 可以观察和约束节点，但不能替代 Router、Edge 或调用栈。
11. 完整 `ctx.pi` 保留，但其副作用不属于托管安全保证。
12. Runtime 的清理和恢复必须覆盖成功、失败、取消和嵌套回滚路径。

## 架构决策索引

- ADR-0001：显式区分 compose、call、delegate 三种图调用边界。
- ADR-0002：固定上下文安全边界，只开放模型可见载荷 renderer。
- ADR-0003：固定 completion 控制 ABI，在 Runtime 校验业务结果并开放 skill 内容来源。

NodeScope、GraphCallScope、compaction baseline、frame segment 和 Mechanism broker 的算法说明属于维护者内部文档，不是理解核心模型的前置条件。
