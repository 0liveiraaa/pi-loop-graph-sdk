# 核心类型与工厂 API

本文列出 Loop Graph SDK 公共导出的核心类型和工厂函数，按使用频率排列。所有类型签名的最终来源为 `src/type.ts` 和 `src/index.ts`，本文为精简参考，省略内部字段。

---

## 工厂函数

### `createLoopGraphExtension(pi, options?)`

创建 LoopGraphExtension 运行时实例。这是业务 extension 的入口点。

```typescript
function createLoopGraphExtension(
  pi: ExtensionAPI,
  options?: LoopGraphExtensionOptions,
): LoopGraphExtension
```

返回的 `LoopGraphExtension` 包含：

| 方法 | 说明 |
| --- | --- |
| `registerGraph(graph)` | 注册一张图。有 `invocation` 的图自动注册为 pi 命令和 LLM 工具。 |
| `executeGraph(graph, trigger, options?)` | 直接执行一张图。内部使用，公开供测试和高级场景。 |

> 同一个实例不支持并发调用 `executeGraph()`，第二个调用立即报错。并发场景应使用独立的 delegate host。

### `createAgentExecute(options?)`

创建 `kind: "code"` 节点的 execute 函数。是 `execute = (_, input, ctx) => ctx.runAgent(...)` 的语法糖。

```typescript
function createAgentExecute(
  options?: AgentExecuteOptions,
): Node["execute"]
```

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | `string \| (input: NodeInput) => string` | 可选。构造传给 LLM 的 prompt；省略时使用 SDK 默认提示。`input.data` 不会自动注入，必须显式传递。 |
| `skill` | `string` | 关联的 skill 名称。 |
| `tools` | `string[]` | **已废弃且不生效**。使用 `Node.tools` 声明。 |
| `outputSchema` | `object` | JSON Schema，LLM 结果不符时自动驳回重试。 |
| `validateCompletion` | `(result) => CompletionValidationResult` | 自定义验证函数。 |

---

## 图结构类型

### `Graph`

```typescript
interface Graph {
  id: string;                              // 唯一标识
  goal: string;                            // 图的总目标
  invocation?: GraphInvocation;            // 对外接口（可选，无则纯子图）
  entries: Entry[];                        // 入口列表
  nodes: Record<string, Node>;             // 节点集合
  routing: Record<string, NodeRouting>;    // 每个节点的路由配置
  mechanisms?: Mechanism[];                // 全局横切机制
}
```

### `GraphInvocation`

```typescript
interface GraphInvocation {
  name: string;                            // 命令名（/xxx）和工具名
  description: string;                     // 描述
  inputSchema: Record<string, unknown>;    // 工具入参 JSON Schema
  parseArgs?(args: string): Record<string, unknown>;  // 命令参数的解析器
  formatToolResult?(result: Readonly<GraphRunResult>): string;  // 工具返回文本
}
```

### `Entry`

```typescript
interface Entry {
  id: string;
  guard(background: Record<string, unknown>): boolean;    // 匹配条件
  startNodeId: string;                                     // 起始节点
  mapInput?(background: Record<string, unknown>): Record<string, unknown>;  // 转换输入
}
```

### `Node`

两种类型，互斥：

```typescript
type Node =
  | {
      kind: "code";
      id: string;
      subGoal: string;            // 子目标（必填）
      skill?: string;             // 关联 skill
      tools?: string[];           // 工具白名单
      mechanisms?: Mechanism[];   // 节点级横切机制
      execute(instance, input, ctx): Promise<NodeCompletion>;
      validateCompletion?: (result) => CompletionValidationResult;
    }
  | {
      kind: "graph";
      id: string;
      subGoal: string;
      graph: Graph;               // 引用的子图
      boundary?: "compose" | "call" | "delegate";  // 默认 call
      fold?: ComposeFrameFolder;  // compose 专属归约函数
    };
```

### `Edge`

```typescript
interface Edge {
  id: string;
  from: string;
  to: string | typeof END;
  priority: number;
  description?: string;           // agent-choice 下建议提供，便于 LLM 判断
  guard(completion: NodeCompletion): boolean;
  migrate(instance: AgentInstance, completion: NodeCompletion): MigrationResult;
}
```

### `MigrationResult`

```typescript
interface MigrationResult {
  frame: ContextFrame;            // 推入帧栈的工作记忆
  output?: Pick<NodeCompletion, "status" | "result">;  // END 边的图返回值
  input?: Record<string, unknown>;  // 下一节点的入参
}
```

### `RouterStrategy`

```typescript
type RouterStrategy =
  | { kind: "first-match" }        // 按数组顺序取首条 guard 匹配
  | { kind: "priority-first" }     // 按 priority 从高到低
  | { kind: "agent-choice" }       // LLM 通过 chosen_edge_id 选择
  | { kind: "custom"; fn: RouterFn }  // 自定义函数
```

### `NodeRouting`

```typescript
interface NodeRouting {
  nodeId: string;
  edges: Edge[];
  router: RouterStrategy;
  agentChoiceField?: string;  // agent-choice 读取的字段名，默认 "chosen_edge_id"
}
```

### `END`

```typescript
const END: unique symbol  // 边指向 END 表示图终止
```

---

## 运行时类型

### `NodeCompletion`

```typescript
interface NodeCompletion {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
  verifiedResult?: Readonly<{
    checks: readonly MechanismVerifiedResultEntry[];
  }>;
}
```

`verifiedResult` 由 Runtime 在机制完成验证门通过时生成，其顶层 `checks` 字段由框架写入。AI 在 `result` 中自报的同名字段无法覆盖 Runtime 生成值。

### `GraphRunResult`

```typescript
interface GraphRunResult {
  graphId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
  steps: number;  // 经过的节点数
}
```

### `GraphRunRequest`

```typescript
interface GraphRunRequest {
  background: Record<string, unknown>;
  invocationKind: "command" | "tool" | "graph-node" | "api";
  boundary: "compose" | "call" | "delegate";
  signal?: AbortSignal;
}
```

### `AgentInstance`

```typescript
interface AgentInstance {
  id: string;
  globalGoal: string;
  background: Record<string, unknown>;
  frames: ContextFrame[];
  mechanisms: Mechanism[];
  scratch: Record<string, unknown>;  // 机制代码侧横切状态（不入 LLM 上下文）
}
```

### `NodeInput`

```typescript
interface NodeInput {
  data: Record<string, unknown>;
  source:
    | { kind: "entry"; entryId: string }
    | { kind: "edge"; edgeId: string; fromNodeId: string };
}
```

### `NodeContext`

```typescript
interface NodeContext {
  signal: AbortSignal;
  runAgent(request: AgentRunRequest): Promise<NodeCompletion>;
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}
```

### `AgentRunRequest`

```typescript
interface AgentRunRequest {
  prompt: string;
  skill?: string;
  outputSchema?: unknown;
  validateCompletion?: (result) => CompletionValidationResult;
}
```

> `tools` 字段已废弃，工具集由 `Node.tools` 统一声明。

### `ContextFrame`

```typescript
interface ContextFrame extends Record<string, unknown> {
  // 所有字段均可选。SDK 不预设结构，内容完全由开发者定义。
}
```

---

## 机制类型

### `Mechanism<TState>`

```typescript
interface Mechanism<TState = Record<string, unknown>> {
  name: string;
  failurePolicy?: "continue" | "fail-node" | "fail-graph";
  createState?(): TState;
  onNodeEnter?(ctx: MechanismContext<TState>): void | Promise<void>;
  beforeAgentRun?(ctx: MechanismAgentRunContext<TState>): void | Promise<void>;
  onTurnStart?(ctx: MechanismTurnStartContext<TState>): void | Promise<void>;
  onTurnEnd?(ctx: MechanismTurnEndContext<TState>): void | Promise<void>;
  onToolStart?(ctx: MechanismToolStartContext<TState>): void | Promise<void>;
  onToolResult?(ctx: MechanismToolResultContext<TState>): void | Promise<void>;
  beforeToolCall?(ctx): ToolCallDecision | void;
  afterToolResult?(ctx): ToolResultDecision | void;
  validateCompletion?(ctx): CompletionDecision | Promise<CompletionDecision>;
  onNodeExit?(ctx: MechanismExitContext<TState>): void | Promise<void>;
  onNodeError?(ctx: MechanismErrorContext<TState>): void | Promise<void>;
}
```

### `CompletionDecision`

```typescript
type CompletionDecision =
  | { action: "allow"; verifiedResult?: Record<string, unknown> }
  | { action: "reject"; reason: string }
  | { action: "fail-node"; reason: string }
  | { action: "fail-graph"; reason: string }
```

### `ToolCallDecision` / `ToolResultDecision`

```typescript
type ToolCallDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "patch"; input: Readonly<Record<string, unknown>> }

type ToolResultDecision =
  | { action: "keep" }
  | { action: "replace"; content?: readonly ToolResultContent[]; isError?: boolean }
```

### 机制上下文能力

所有 Hook 都从相应的 context 对象获得以下基础能力；具体 Hook 还会增加只读的 `event`、`completion`、`error`、`request` 或 `agentRunId`。

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `pi` | `ExtensionAPI` | 完整但非托管的上游能力；副作用不会自动清理。上游 API 见 pi 官方定义。 |
| `instance` | `AgentInstance` | 当前逻辑工作实例。 |
| `node` / `input` | `Node` / `NodeInput` | 当前节点及本次输入。 |
| `scope` | `MechanismScope` | 当前节点执行周期的取消信号、活跃检查与清理注册。 |
| `events` | `MechanismEvents` | 当前周期内的工具结果和 turn 事件订阅；结束时自动取消。 |
| `exec` | `MechanismExec` | 受根目录、超时、取消信号及输出预算约束的命令执行器。 |
| `decisions` | `MechanismDecisionLog` | 当前工具控制决策的只读记录。 |
| `state` | `TState` | 当前机制在该 `AgentInstance` 内的私有状态。 |
| `context.append()` | `(content) => boolean` | 向模型消息流追加文本或图片；周期失效后返回 `false`。 |
| `appendContext()` | 同上 | 已废弃的兼容别名；使用 `context.append()`。 |

```typescript
interface MechanismScope {
  readonly scopeId: string;
  readonly visit: number; // 仅用于诊断节点第几次进入
  readonly signal: AbortSignal;
  isActive(): boolean;
  onCleanup(cleanup: () => void | Promise<void>): void;
}

interface MechanismEvents {
  onToolResult(handler): MechanismEventSubscription;
  onTurnStart(handler): MechanismEventSubscription;
  onTurnEnd(handler): MechanismEventSubscription;
}

interface MechanismEventSubscription {
  readonly disposed: boolean;
  dispose(): void;
}

interface MechanismExec {
  run(command: string, args?: readonly string[], options?: {
    timeoutMs?: number;
    cwd?: string;
    maxOutputBytes?: number;
  }): Promise<MechanismExecResult>;
}
```

`MechanismExecResult` 提供 `stdout`、`stderr`、`code`、`killed`、`stdoutTruncated` 和 `stderrTruncated`。`verifiedResult.checks` 中每项包含 `mechanismName` 与该机制返回的只读 `result`。

### Hook context 对照

| Hook | context 增量字段 |
| --- | --- |
| `onNodeEnter` | 仅基础能力 |
| `beforeAgentRun` | `agentRunId`、只读 `request` |
| `onTurnStart` / `onTurnEnd` | `agentRunId`、只读 `event` |
| `onToolStart` / `onToolResult` | `agentRunId`、只读 `event` |
| `beforeToolCall` / `afterToolResult` | `agentRunId`、只读 `event` |
| `validateCompletion` | `agentRunId`、只读 `completion` |
| `onNodeExit` | 只读 `completion` |
| `onNodeError` | 只读 `error` |

事件观察和工具控制 Hook 属于不同通道：`ctx.events` 返回可提前 dispose 的订阅；同名 Mechanism Hook 由 Runtime 自动调用。

---

## 其他公开 API

| 导出 | 说明 |
| --- | --- |
| `GraphRegistry` | 图注册表类 |
| `GraphRuntime` | 图运行时状态机类（高级用法） |
| `selectEdge` | 路由边的选择函数 |
| `validateGraph` / `assertValidGraph` | 图结构校验 |
| `validateGraphTools` | 工具存在性校验 |
| `resolveNodeTools` / `defaultToolResolver` | 工具集解析 |
| `FRAMEWORK_TOOLS` | 框架强制工具常量（`read` + `__graph_complete__`） |
| `projectMessages` / `defaultFrameFormatter` / `defaultNodeContextRenderer` | 消息投影（高级） |
| `stripClosedGraphCalls` | 清洗已闭合图调用区段（高级） |
| `IsolatedSessionGraphHost` / `createIsolatedGraphSessionFactory` | delegate host 实现 |
| `createJsonlTraceSink` | 创建 JSONL 日志 sink |
| `defaultSkillContentProvider` / `defaultSkillContentRenderer` | 默认 skill 加载与渲染 |
| `encodeGraphToolResult` / `limitGraphToolResultText` | 图工具结果编码与截断 |

已废弃但仍导出的兼容 API：
- `registerGraph` / `initRegistry` / `findEntry`（使用 `createLoopGraphExtension` 代替）

### 配置、渲染与消息类型

| 导出 | 查询位置或用途 |
| --- | --- |
| `LoopGraphExtensionOptions` / `LoopGraphLimits` | [配置项参考](configuration.md) |
| `LoopGraphExecutionOptions` | 单次 `executeGraph` 的覆盖项；目前只有 `contextRenderer`。 |
| `ContextRendererRegistry` | 按 graphId/nodeId 注册上下文渲染器。 |
| `ProjectionInput` / `MessageEntry` | 高级消息投影的输入和输出条目。 |
| `GraphContextView` / `NodeContextView` / `NodeInputView` | renderer 接收的只读图、节点和输入视图。 |
| `EdgeChoice` | agent-choice 渲染上下文中的只读候选边摘要。 |
| `NodeContextRenderInput` / `NodeContextRenderer` | 节点上下文渲染器输入与函数类型。 |
| `RenderedContextContentBlock` / `RenderedContextMessage` / `RenderedNodeContext` | renderer 可返回的文本、图片和锚点结构。 |
| `ModelMessageFormatter` | validation retry、节点未完成、dead-run 和图失败文案集合。 |
| `ValidationRetryMessageInput` / `IncompleteNodeMessageInput` / `DeadRunMessageInput` / `GraphFailureMessageInput` | 上述四种 formatter 的只读输入。 |
| `CompletionToolResultFormatter` / `CompletionToolResultInput` | `__graph_complete__` 工具结果文本 formatter 及输入。 |

### Skill、工具解析与观测类型

| 导出 | 用途 |
| --- | --- |
| `SkillContentProvider` / `SkillLoadContext` | 异步加载 skill 正文；上下文包含引用、图和节点身份。 |
| `SkillContentRenderer` | 把已加载正文转换为模型可见内容。 |
| `SkillFailurePolicy` / `SkillFailurePolicies` | skill 缺失或加载错误的处理策略。 |
| `ToolResolver` / `ToolResolverInput` | 接收默认、节点、框架工具及图/节点身份，返回候选工具名。 |
| `LoopGraphLifecycleEvent` | `graph_start/end/error`、`node_enter/exit`、`compaction` 的只读联合类型。 |
| `LoopGraphTraceSink` / `LoopGraphLogger` | 结构化事件 sink 与 debug/error logger。 |

### 校验与独立执行类型

| 导出 | 用途 |
| --- | --- |
| `GraphValidationIssue` | `code`、`message`、`path` 组成的校验问题。 |
| `GraphValidationOptions` | 声明执行载体支持的调用边界及 delegate host 可用性。 |
| `GraphExecutionHost` | 接收 `GraphRunRequest` 并返回 `GraphRunResult` 的执行载体契约。 |
| `IsolatedGraphSession` / `IsolatedGraphSessionFactory` | delegate 使用的隔离 Session 及其工厂。 |
| `IsolatedSessionGraphHostOptions` / `IsolatedGraphSessionFactoryOptions` | 隔离 host 和递归子会话的构造配置。 |

---

## 相关链接

- [配置项参考](configuration.md) — `LoopGraphExtensionOptions` 全字段解释
- [生命周期](lifecycle.md) — 执行顺序
- [错误与限制](errors-and-limits.md) — failurePolicy、超时、步数限制
- 完整类型定义：`src/type.ts`
- pi ExtensionAPI 定义：见 pi 官方文档
