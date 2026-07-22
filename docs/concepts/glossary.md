# Loop Graph SDK 术语表

本文定义项目稳定的术语和概念边界。使用方法和类型签名分别属于指南和参考文档。

## 图与执行

**图定义（Graph Definition）**：一套可独立调用和复用的工作流定义，拥有目标、入口、阶段装配、工具权限和版本。通过 `defineGraph()` 创建。

**图版本（Graph Version）**：同一 Graph ID 下的不可变修订身份，用于注册、调用和回放。表达先后关系，不承诺 SemVer 兼容。通过 `id` + `version` 唯一定位。

**图引用（GraphRef）**：`{ id: string; version: string }`，用于在图节点中引用子图。由 `graphRef(id, version)` 创建，由 Graph Catalog 解析。

**元图（Meta-Graph）**：以生成或迭代其他 Graph Definition 为目标的图。SDK 尚未提供一等 API，但 Core 基础设施（Agent 推理、图验证、Catalog 注册）已可用于实验。

**图输入（Graph Input）**：调用图时提供并经过 `input` schema 校验的完整结构化数据。Entry、Code Node 和 Transition 可读取。**不会整体自动进入模型上下文**。

**背景上下文（Background）**：从 Graph Input 中通过 `background.select` 显式提取的模型可见投影。在一次 Graph Invocation 内保持不变。必填，必须写 `"all"`、`"none"` 或 selector 函数。

**图调用（Graph Invocation）**：一次使用明确输入启动图并取得结果的过程。拥有独立的目标投影和背景上下文。

**入口（Entry）**：图对调用输入的匹配规则及起始阶段。`entry.guard` 按数组顺序 first-match；`entry.mapInput` 为第一个节点构造输入。

**阶段（Stage）**：图中把一个 Node Definition 与其出口 Route 装配在一起的位置。Stage ID 是图内唯一运行身份，使用 `Record<StageId, Stage>`。

**节点定义（Node Definition）**：描述节点内部工作及可用能力的可复用定义。不持有图内位置或连接关系。分为 `agentNode`、`codeNode`、`graphNode` 三种。

**Agent 节点（Agent Node）**：声明一次标准 Agent 工作（调用 LLM）的节点。由 Runtime 完成 Agent Run 和结果提交。通过 `agentNode({ subGoal, prompt, input, output, tools, skills, context })` 定义。

**代码节点（Code Node）**：运行确定性代码或混合逻辑的节点。通过 `codeNode({ execute })` 定义。内部可通过 `runAgent()` 发起零次或多次 Agent Run。

**图节点（Graph Node）**：通过 call、compose 或 delegate 调用另一张图的节点。通过 `graphNode({ graph: graphRef(...), boundary })` 定义。

**节点子目标（Node Subgoal）**：当前节点在整张图目标下的局部目标。是 Node Definition 的稳定内容，会出现在模型上下文投影中。

**节点输入（Node Input）**：Entry 或上一条 Connection 为一次 Node Visit 构造的完整结构化输入。生命周期只到当前访问结束。

**节点焦点（Node Focus）**：从 Node Input 中通过 `focus.select` 显式提取的模型可见投影。Agent Node 默认 `"all"`，Code Node 默认 `"none"`。

**调用边界（Invocation Boundary）**：Graph Node 调用子图时选择的 call、compose 或 delegate 运行方式。属于调用位置，不属于被调用图定义。

## 路由与迁移

**路由（Route）**：阶段出口的规则集合。`firstMatch` 按顺序取首个 guard 匹配的 Connection。

**连接（Connection）**：阶段出口到另一阶段或 `__graph_finish__` 的拓扑关系。持有目标 ID 和 Transition。

**迁移（Transition）**：Connection 的迁移策略。包含可选的 guard（条件）、frame（工作记忆）、map（下一节点输入映射）和 output（finish 时的图输出）。

**`finish()`**：指向图终点的特殊 Connection。必须提供 `output` 函数显式产生符合 Graph output 契约的值。

## 数据与投影

**上下文投影（Context Projection）**：`{ select, render }` 协议。`select` 决定哪些业务数据允许进入该层上下文，`render` 决定如何展示。三层投影：

- `Graph.context.background`：从 Graph Input 投影稳定图级信息
- `Graph.context.memory`：从 Frames（已完成工作记忆）投影历史
- `Node.context.focus`：从 Node Input 投影当前节点焦点

每一层 renderer 只能读取自己的 selected 数据和 meta，不能访问其他层。

**工作记忆（Frame）**：Transition 中通过 `frame()` 写入的持久数据。在整个 Graph Invocation 的后续节点中通过 Memory 投影可见。compose 子图共享父图 Frames。

**输出契约（Output Contract）**：Agent Node 的 `output` schema 同时驱动单次 Agent Run 的契约和 Node Completion 的校验来源。只在所属 Agent Run 中 sticky，run 结束立即删除。

## 工具与技能

**Host 工具目录（Host Tool Catalog）**：真实工具实现的注册中心，构成最终能力边界。

**图工具权限（Graph Tool Policy）**：图声明的业务工具可选全集。节点只能从中选择。通过 `tools: toolSet("read", "write")` 声明。

**节点工具集（Node Tool Set）**：节点从图权限中实际启用的工具集合。省略时无业务工具；`tools: "all"` 选择图声明的全部。

**协议工具（Protocol Tool）**：Runtime 强制提供的工具。当前仅 `__graph_complete__`。

**SkillRef**：对 Skill 的结构化引用（name、version、required）。Graph 和 Node 可声明 `skills: [skillRef(...)]`。由 Host Skill Catalog 解析。

## Mechanism

**Mechanism**：作用于图运行过程的横切扩展。三层安装：

- **Host Mechanism**：作用于整个 Root Run 及所有子调用，不可被调用边界绕过
- **Graph Mechanism**：作用于当前图，进入子图后由子图自身的 Graph Mechanism 接管
- **Node Mechanism**：作用于当前 Node Visit，同一次访问的多次 Agent Run 共享状态

每个 Mechanism 的生命周期和 state 由安装位置决定。

Hook 顺序：进入 Host→Graph→Node，退出 Node→Graph→Host。Host 拥有最终否决权。

## 执行与结果

**执行 Host（Execution Host）**：承载图运行所需模型会话、工具实现、限制、持久化和生命周期的运行环境。通过 `createGraphHost()` 创建。一个 Host 同时只允许一个 Root Run。

**GraphRunResult**：`completed | failed | cancelled` 判别联合。成功分支使用 `output`，失败分支使用 `failure`（包含稳定 code、phase、retryable、stageId）。

**稳定 failure code**：`invalid-graph`、`invalid-input`、`entry-not-found`、`tool-unavailable`、`host-unavailable`、`agent-timeout`、`agent-ended-without-completion`、`validation-exhausted`、`max-steps-exceeded`、`no-route`、`transition-failed`、`mechanism-failed`、`persistence-failed`、`resume-incompatible`、`runtime-error`、`cancelled`。

## 回放与恢复

**工作回放（Work Replay）**：一次图运行中可供人类复盘的工作记录。默认模式 `"replay"`，包含模型可见上下文、Assistant 正文、工具交互、验证和迁移。默认不含隐藏推理，密钥已脱敏。

**持久回放（Durable Replay）**：跨进程保存的运行记录。journal JSONL → finalize → replay JSON → parse → Replay Model → HTML。默认存储于 `.loop-graph/runs/<runId>`。

**运行恢复（Run Resume）**：从 checkpoint 继续未完成的图运行。只承诺 Node 边界恢复（Transition 完成、下一 Node 未开始）。不序列化模型 turn 或正在执行的工具调用。
