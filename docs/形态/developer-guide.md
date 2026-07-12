# Loop Graph SDK 开发者指南

## 概要

Loop Graph SDK 是一个基于 pi-extension 的 agent 编排框架。

**核心模型**：一个回路图（Graph）由节点（Node）、边（Edge）和路由策略（Router）组成。Agent 实例在图中流动——进入节点工作、结束后通过边迁移到下一节点、重复直到终点（END）。

**关键特性**：

- **帧栈折叠**：已完成节点的 ReAct 过程被折叠为摘要帧，后续节点只看到摘要，不看到原始展开过程
- **三种图调用边界**：`call`（创建新 AgentInstance，帧栈隔离）、`compose`（复用父 AgentInstance，帧段强制归约）、`delegate`（独立 AgentSession，物理隔离，通过 `DelegateGraphInvoker` 执行）
- **不干预 ReAct**：框架只编排"什么时候跑什么节点"，不干涉节点内部的 LLM 推理循环
- **全员函数扩展**：所有定制点都是函数（`guard`、`migrate`、`execute`、`validateCompletion`、`custom router`），无黑盒限制
- **框架不引入全局隐式状态**：所有跨节点数据流经帧栈显式传递，不依赖闭包或模块变量
- **框架不修改 system prompt**：所有上下文操作在消息流追加侧进行，不破坏 pi 原生 prompt 管理

---

## 自定义 Frame 与图返回

`Edge.migrate` 的 `frame` 是给后续模型使用的业务工作记忆，字段完全由开发者决定。只保留后续工作真正需要的信息，并保持序列化结果短小、稳定，以兼顾上下文效果和 KV cache：

```typescript
return {
  frame: {
    findings: ["连接正常", "并发写入时出现问题"],
    next: "检查事务隔离级别",
  },
  output: edge.to === END
    ? { status: completion.status, result: completion.result }
    : undefined,
};
```

`nodeId/status/summary/result` 仍可用于旧图，但不再是必填字段。END 边推荐使用 `output` 声明对外返回，不要让模型记忆结构承担函数返回协议。

发生 pi compaction 后，原生 summary 和 recent messages 会继续进入当前节点上下文；压缩前已有 frames 不再重复投影，新 frames 从压缩基线继续生长。开发者无需在 frame 中记录 compaction 或 scope 元数据。

---

## 两种使用方式

### 方式 A：作为 debug/demo pi extension 使用

```bash
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
```

这会加载 SDK 自带 debug extension（`./extension`），注册测试图（`/echo-test`、`/probe`、`/chain`、`/sub`、`/validate-test`）。用于验证 SDK 是否正常工作、探索图机制。

**注意**：`pi install` 并列安装不等于其它 pi package 可以直接导入 SDK。如果需要以 library 形式使用，请看方式 B。

### 方式 B：作为业务 extension 的 library 依赖

业务 package 在自己的 `package.json` 中声明依赖：

```json
{
  "dependencies": {
    "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1"
  }
}
```

然后创建独立运行时并注册图：

```typescript
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { myGraph } from "./graphs/my-graph";

export default function myExtension(pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(myGraph);
}
```

**关键区别**：

- 方式 A：SDK 自带的 debug extension 入口，等价于 `createLoopGraphExtension(pi, { demoGraphs: true })`
- 方式 B：业务代码导入 library API，创建自己的运行时实例，demo graphs 不注册

### 运行时工厂选项

`createLoopGraphExtension(pi, options?)` 支持以下选项：

```typescript
interface LoopGraphExtensionOptions {
  /** 是否注册 SDK 自带测试图。默认 false。只有 debug extension 入口设为 true。 */
  demoGraphs?: boolean;
  /** 所有节点默认可用的工具列表。为空时只保留 read + __graph_complete__。
   *  例如业务包可传入 ["review_card", "review_chapter"] 作为全局工具。
   *  注意：工具集最终由 resolveNodeTools(defaultTools, node.tools) 合并并去重。 */
  defaultTools?: string[];
  /** skill 目录的根路径。node.skill 的 SKILL.md 在此路径下按 {name}/SKILL.md 查找。
   *  默认 process.cwd() + "/skills"。参见 §skill 集成。 */
  skillBasePath?: string;
  /** 自定义帧折叠后注入到 agent 上下文的格式。
   *  接收 ContextFrame[]，返回完整文本或 null（跳过 COMPLETED 段）。
   *  默认保持 JSON 格式。参见 §帧栈与投影。 */
  frameFormatter?: (frames: ContextFrame[]) => string | null;
  /** 自定义节点进入时 SDK 给模型追加的 CURRENT/skill/完成说明。 */
  contextRenderer?: NodeContextRenderer;
  /** 按 graphId/nodeId 声明更具体的 renderer。 */
  contextRenderers?: {
    graphs?: Record<string, NodeContextRenderer>;
    nodes?: Record<string, Record<string, NodeContextRenderer>>;
  };
  /** 自定义 retry、incomplete、dead-run 和 graph failure 文案。 */
  modelMessageFormatter?: Partial<ModelMessageFormatter>;
  /** 自定义 __graph_complete__ 工具返回给模型的文本。 */
  completionToolResultFormatter?: CompletionToolResultFormatter;
  /** 异步加载 node.skill；默认读取 skillBasePath/{ref}/SKILL.md。 */
  skillProvider?: SkillContentProvider;
  /** 自定义 skill 正文的模型展示；返回 null 可隐藏。 */
  skillRenderer?: SkillContentRenderer;
  skillFailure?: {
    missing?: "ignore" | "fail"; // 默认 ignore
    error?: "ignore" | "fail";   // 默认 ignore
  };
  /** 图循环与单次 agent run 的运行限制。 */
  limits?: {
    rootMaxSteps?: number;       // 默认 100
    childMaxSteps?: number;      // 默认 50
    agentRunTimeoutMs?: number;  // 默认 300000（5 分钟）
  };
}
```

### 自定义当前节点上下文

`contextRenderer` 控制 SDK 在节点进入时主动追加给模型的内容。它不会拿到完整对话，也不能替换 NodeScope、子图清洗或 compaction 逻辑：

```typescript
const loop = createLoopGraphExtension(pi, {
  contextRenderer(input) {
    return {
      anchor: {
        kind: "current",
        content: `当前任务：\n${input.node.subGoal}\n\n完成后请提交结构化结果。`,
      },
    };
  },
});
```

这样模型不再默认看到 nodeId、工具名、skill 名、edge target/priority 或 `=== CURRENT ===` 标签。renderer 可以读取：

- 当前 graph、node 和 NodeInput；
- node-enter 时的可见 frame 快照；
- agent-choice 可选边；
- 已加载的单个 skill 正文；
- 固定 completion 协议名称和状态。

renderer 是同步函数，每次节点进入只执行一次。输入中的 graph/node/input/frames 是 SDK 创建的只读快照，不是 Runtime 的真实可变对象；renderer 无法通过修改输入改变图或帧栈。返回值分为 `anchor` 和可选 `additional`，SDK 会复制并冻结文本块；scope 丢失或 compaction 恢复时复用同一结果，不重新调用 renderer。返回 `null` 或 `anchor: null` 表示不展示锚点正文，但 SDK 仍保留正文为空的内部 NodeScope 锚点并继续 fail-closed。

历史 frame 的主展示仍使用 `frameFormatter`。这是因为同一节点运行期间 compaction 可能改变哪些 frames 还应显示；把完整 frames 写死在冻结 renderer 结果中会重复展示已压缩历史。需要完全自定义时同时配置：

```typescript
createLoopGraphExtension(pi, {
  frameFormatter: (frames) => renderBusinessMemory(frames),
  contextRenderer: (input) => ({ anchor: { content: renderCurrentTask(input) } }),
});
```

未提供 `contextRenderer` 时，`defaultNodeContextRenderer` 保持原有 CURRENT 和 `[skill: name]` 格式。

### Graph、Node 与调用级覆盖

不需要把 renderer 写进核心 Graph/Node 定义，可以在 adapter 配置中按 ID 声明：

```typescript
const loop = createLoopGraphExtension(pi, {
  contextRenderer: renderDefault,
  contextRenderers: {
    graphs: {
      contract_review: renderContractGraph,
    },
    nodes: {
      contract_review: {
        final_check: renderFinalCheckNode,
      },
    },
  },
});
```

直接使用低层 API 时还可以覆盖本次调用：

```typescript
await loop.executeGraph(
  graph,
  { source: "command", args: "" },
  { contextRenderer: renderThisRun },
);
```

覆盖顺序固定为：

```text
本次 executeGraph 调用
> 当前 Node
> 当前 Graph
> Extension 默认
> SDK 兼容 renderer
```

调用级 renderer 会沿同一 Session 的 `call/compose` 子图传播。`delegate` 创建独立 AgentSession，不隐式继承调用函数；需要在 `createIsolatedGraphSessionFactory()` / delegate host factory 的配置中声明其 renderer registry。任何 renderer 抛错都会让图 fail-closed，不会回退默认 CURRENT 或原始 transcript。

所有 limit 必须是有限正整数，非法值会在 `createLoopGraphExtension()` 时直接报错。默认值保持历史行为。`rootMaxSteps` 只控制公开低层 `executeGraph()` 的顶层循环；`childMaxSteps` 控制同一 Runtime 内的 `call/compose` 子图。delegate 图在独立 host 中运行，使用该 host 创建时传入的 limits。

同一个 `LoopGraphExtension` instance 不支持并发调用低层 `executeGraph()`。第二个 root run 会在修改活动 Runtime 前 fail-fast；需要并发时应为每个任务创建独立 AgentSession/delegate host。仅在同一个 pi Session 上再创建一个 extension instance 不构成事件隔离，不能作为并发方案。图内部的嵌套 `call/compose` 使用同一个 Runtime callStack，不属于并发 root run。

`defaultTools` 在注册期通过 `resolveNodeTools` 与每个节点的 `tools` 合并并去重：

```text
最终工具集 = read + defaultTools ∪ node.tools + __graph_complete__（去重，read 强制首位）
```

这样业务包不需要在每个节点重复声明全局可用工具。

---

## 快速开始

### 定义第一个图

```typescript
import { createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";
import { END } from "pi-loop-graph-sdk";

const greetNode: Node = {
  kind: "code",
  id: "greet",
  subGoal: "接收用户输入并复述",
  execute: createAgentExecute(),
};

const entry: Entry = {
  id: "main",
  guard: () => true,
  startNodeId: "greet",
};

const done: Edge = {
  id: "greet_done",
  from: "greet",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: "问候完成",
        result: completion.result,
      },
    };
  },
};

export const myGraph: Graph = {
  id: "hello_world",
  goal: "简单的问候图",
  invocation: {
    name: "hello",
    description: "问候测试",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    // parseArgs 将 /hello 世界 → { name: "世界" }
    parseArgs: (a) => ({ name: a || "世界" }),
  },
  entries: [entry],
  nodes: { greet: greetNode },
  routing: {
    greet: { nodeId: "greet", edges: [done], router: { kind: "first-match" } },
  },
};
```

### 注册到 extension

```typescript
// 在 extension 入口
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { myGraph } from "./graphs/my-graph";

export default function myExtension(pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(myGraph);
}
```

用户输入 `/hello` 触发图运行。

---

## 核心概念

### Graph（回路图）

```typescript
interface Graph {
  id: string;                            // 唯一标识
  goal: string;                          // 图的总目标
  invocation?: GraphInvocation;          // 对外接口（命令名、描述、参数 schema）
  entries: Entry[];                      // 入口列表
  nodes: Record<string, Node>;           // 节点集合
  routing: Record<string, NodeRouting>;  // 每个节点的路由配置
  mechanisms?: Mechanism[];              // 全局横切机制，跨节点生效
}
```

- 有 `invocation` → 对用户可见，自动注册为 pi 命令和工具
- 无 `invocation` → 纯子图，只能被别的节点引用

### Entry（入口）

```typescript
interface Entry {
  id: string;
  guard(background: Record<string, unknown>): boolean;  // 匹配条件
  startNodeId: string;                                    // 第一个节点
  mapInput?(background: Record<string, unknown>): Record<string, unknown>;  // 可选：转换输入
}
```

`guard` 决定"什么情况下走这个入口"。多入口通过 guard 区分。

### Node（节点）

两种形态，互斥：

```typescript
type Node =
  | {
      kind: "code";
      id: string;
      subGoal: string;
      skill?: string;                                     // 关联 skill
      tools?: string[];                                   // 工具白名单
      mechanisms?: Mechanism[];
      execute(instance, input, ctx): Promise<NodeCompletion>;  // 总是调用
      validateCompletion?: (result) => { isValid, reason };    // 可选验证
    }
  | {
      kind: "graph";
      id: string;
      subGoal: string;
      graph: Graph;                                       // 引用的子图
      boundary?: "compose" | "call" | "delegate";        // 图调用边界，缺省 call
      fold?: ComposeFrameFolder;                          // compose 专属：帧段归约策略
    };
```

| 节点类型                        | execute                       | 引擎行为                                  |
| ------------------------------- | ----------------------------- | ----------------------------------------- |
| `kind: "code"` 有 skill/tools | `createAgentExecute()` 工厂 | 调 execute → 内部调 runAgent → LLM 推理 |
| `kind: "code"` 纯逻辑         | 自定义函数                    | 调 execute → 直接返回 NodeCompletion     |
| `kind: "graph"`               | 不提供                        | 按 boundary 委托子图执行                  |

`boundary` 缺省为 `call`，已有业务图无需修改。`call/delegate + fold` 在校验期报错。未配置 `createDelegateHost` 时 delegate 会抛明确错误。

### Mechanism（横切机制）

Mechanism 是围绕一次节点工作过程运行的代码侧横切能力。它既能观察 Agent、turn 和工具生命周期，也能通过有限决定拦截工具、脱敏结果，并运行受节点作用域约束的外部命令。每个 mechanism 在每次 node visit 中获得独立 scope；节点正常结束或抛错时，Runtime 都会关闭 scope、触发 abort，并按 LIFO 执行 cleanup。

```typescript
interface MechanismScope {
  readonly scopeId: string;
  readonly visit: number;
  readonly signal: AbortSignal;
  isActive(): boolean;
  onCleanup(cleanup: () => void | Promise<void>): void;
}

interface MechanismContext<TState = Record<string, unknown>> {
  pi: ExtensionAPI;                              // 完整但非托管的 pi 能力
  instance: AgentInstance;                       // 当前实例（scratch 可写）
  node: Node;                                    // 当前节点
  input: NodeInput;                              // 代码侧入参
  scope: MechanismScope;                         // 当前 node visit 的托管生命周期
  events: MechanismEvents;                       // scoped 事件订阅，scope 关闭时自动取消
  exec: MechanismExec;                           // 受控命令执行，绑定 signal/timeout/cwd/输出预算
  decisions: MechanismDecisionLog;               // 当前 scope 的工具决策 trace
  state: TState;                                 // 类型化私有 state，跨 visit 保留
  context: MechanismContextAppender;              // 推荐：文本/图片内容块的受控追加
  appendContext(content: MechanismContextContent): boolean; // 兼容别名
}

interface MechanismEvents {
  onToolResult(handler: (event: MechanismToolResultEvent) => void | Promise<void>): MechanismEventSubscription;
  onTurnStart(handler: (event: MechanismTurnStartEvent) => void | Promise<void>): MechanismEventSubscription;
  onTurnEnd(handler: (event: MechanismTurnEndEvent) => void | Promise<void>): MechanismEventSubscription;
}

interface MechanismEventSubscription {
  readonly disposed: boolean;
  dispose(): void;                               // 幂等，scope 关闭时自动调用
}

interface Mechanism<TState = Record<string, unknown>> {
  name: string;
  failurePolicy?: "continue" | "fail-node" | "fail-graph";
  createState?(): TState;                        // 当前 AgentInstance 中按机制对象身份懒初始化一次
  onNodeEnter?(ctx: MechanismContext<TState>): void | Promise<void>;
  beforeAgentRun?(ctx: MechanismAgentRunContext<TState>): void | Promise<void>;
  onTurnStart?(ctx: MechanismTurnStartContext<TState>): void | Promise<void>;
  onTurnEnd?(ctx: MechanismTurnEndContext<TState>): void | Promise<void>;
  onToolStart?(ctx: MechanismToolStartContext<TState>): void | Promise<void>;
  onToolResult?(ctx: MechanismToolResultContext<TState>): void | Promise<void>;
  beforeToolCall?(ctx: MechanismToolCallContext<TState>): ToolCallDecision | void | Promise<ToolCallDecision | void>;
  afterToolResult?(ctx: MechanismToolResultContext<TState>): ToolResultDecision | void | Promise<ToolResultDecision | void>;
  validateCompletion?(ctx: MechanismCompletionContext<TState>): CompletionDecision | Promise<CompletionDecision>;
  onNodeExit?(ctx: MechanismExitContext<TState>): void | Promise<void>;
  onNodeError?(ctx: MechanismErrorContext<TState>): void | Promise<void>;
}
```

执行顺序：

```text
enterNode
→ AgentInstance.mechanisms
→ 当前 CallFrame.localMechanisms
→ Node.mechanisms
→ execute
  → beforeAgentRun
  → [onTurnStart → beforeToolCall → tool → afterToolResult/onToolResult → onTurnEnd] × N
  → validateCompletion × N（reject 时继续下一 turn）
→ onNodeExit（Router/Edge 之前）
→ scope abort + cleanup
```

规则：

- 全局机制写在 `Graph.mechanisms`，跨节点持续生效。
- compose 子图的 Graph mechanisms 作为当前 CallFrame 的局部机制，退出子图后撤销。
- 局部机制写在 `Node.mechanisms`，只在当前节点叠加。
- `onNodeEnter` 串行 await；抛错记日志后继续，不中止节点。
- 每次 `runAgent()` 分配独立 `agentRunId`；同一节点连续调用时，正式 turn/tool Hook 不会把上一轮事件归到下一轮。
- `beforeToolCall` 的 patch 按机制顺序组合并重新执行工具 schema 校验；没有可靠 schema 时拒绝 patch。`__graph_complete__` 不允许走一般 patch。
- `afterToolResult` 只能替换模型可见 `content/isError`，不能改 `details/toolCallId/toolName`。
- `validateCompletion` 只在 AI 上报 `status: "ok"` 时执行；可 allow、reject、fail-node 或 fail-graph。可信结果位于顶层 `completion.verifiedResult.checks`，不会与 AI 的 `completion.result` 合并。
- 完整顺序为 outputSchema → runAgent validator → Node validator → Mechanism gate → agent-choice。
- `onNodeExit` 在节点产出 completion 后、Router/Edge 处理前串行执行，收到无别名只读快照。
- node visit 任意阶段抛错时调用 `onNodeError`；它只观察原始错误，不能替换主错误。
- 没有声明任何生命周期 Hook 的 mechanism 被跳过。
- cleanup 逆注册顺序执行；一个 cleanup 抛错不会阻止其他 cleanup，也不会覆盖节点原始错误。

失败策略：

| `failurePolicy` | Hook 抛错后的行为 |
| --- | --- |
| `continue` | 记日志并继续，默认值，保持兼容 |
| `fail-node` | Runtime 生成可信 failed completion，跳过/终止节点主体并交给 Router |
| `fail-graph` | 终止当前图调用，但仍执行 `onNodeError` 和全部 cleanup |

同一阶段多个机制发生控制性失败时，全部 Hook 仍按顺序执行，最终优先级为 `fail-graph > fail-node > continue`。Runtime 使用自己的当前 nodeId 生成失败 completion，不接受 mechanism 伪造节点身份。`onNodeError` 自身抛错只作为次级诊断，已有主错误始终保留。

两层能力面：

| 通道 | 作用 | Runtime 保证 |
| --- | --- | --- |
| `ctx.scope` | signal、active 检查、cleanup | 与当前 node visit 同生共死 |
| `ctx.events` | scoped 事件订阅（onToolResult/onTurnStart/onTurnEnd） | 底层单一 pi listener；scope 关闭时自动 dispose；handler 失败进入 failurePolicy |
| `ctx.state` | 类型化私有 state，由 `createState()` 懒初始化 | 双层 WeakMap 按 AgentInstance + mechanism 对象身份隔离；call 创建新 state，compose 复用；不入模型上下文 |
| `ctx.exec.run()` | 执行节点级外部命令 | 自动绑定 scope signal；限制 timeout、cwd 根目录和 stdout/stderr 字节数 |
| `ctx.decisions.list()` | 读取工具决策记录 | 返回当前 scope 内复制的只读 trace |
| `ctx.appendContext(content)` | 向当前 NodeScope 追加上下文 | 失效后返回 `false`，不会污染后继节点 |
| `ctx.context.append(content)` | 追加 string 或 text/image blocks | 固定消息类型、display、scope details 与非 triggerTurn 选项；内容复制冻结 |
| `ctx.instance.scratch` | 代码侧共享横切状态 | 随 AgentInstance 生命周期；当前仍是共享命名空间 |
| `ctx.pi` | 完整 pi ExtensionAPI | 仅保证原生 API 可用；副作用不自动获得 scope/cleanup 保证 |

安全生命周期示例：

```typescript
const timingMechanism: Mechanism = {
  name: "timing",
  onNodeEnter(ctx) {
    ctx.instance.scratch[`${ctx.node.id}_started`] = Date.now();
    const timer = setInterval(() => collectSample(), 1000);
    ctx.scope.onCleanup(() => clearInterval(timer));

    ctx.scope.signal.addEventListener("abort", () => cancelBackgroundWork(), {
      once: true,
    });

    ctx.context.append("计时与监控已启动");
  },
};
```

私有 state 示例（跨 visit 计数，由 `createState` 懒初始化）：

```typescript
const retryTracker: Mechanism<{ retries: number }> = {
  name: "retry-tracker",
  createState: () => ({ retries: 0 }),
  onNodeExit(ctx) {
    if (ctx.completion.status === "failed") {
      ctx.state.retries += 1;
      ctx.context.append(`已重试 ${ctx.state.retries} 次`);
    }
  },
};
```

scoped event 示例（scope 退出时自动取消订阅，不积累底层 listener）：

```typescript
const toolObserver: Mechanism = {
  name: "tool-observer",
  onNodeEnter(ctx) {
    ctx.events.onToolResult((event) => {
      ctx.context.append(`工具 ${event.toolName} 完成`);
    });
    // scope 关闭时自动 dispose 全部订阅，无需手动清理
  },
};
```

工具门禁与结果脱敏示例：

```typescript
const safeRead: Mechanism = {
  name: "safe-read",
  beforeToolCall(ctx) {
    if (ctx.event.toolName !== "read") return { action: "allow" };
    if (!String(ctx.event.input.path).startsWith("docs/")) {
      return { action: "deny", reason: "只允许读取 docs 目录" };
    }
    return { action: "allow" };
  },
  afterToolResult(ctx) {
    if (ctx.event.toolName === "read" && containsSecret(ctx.event.content)) {
      return { action: "replace", content: [{ type: "text", text: "[内容已脱敏]" }] };
    }
    return { action: "keep" };
  },
};
```

`ctx.exec.run("npm", ["test"], { timeoutMs: 60_000 })` 会自动使用当前 scope 的取消信号。默认 cwd 受 `mechanismRuntime.execRoot` 限制，输出超过预算时返回截断文本及 `stdoutTruncated/stderrTruncated` 标记。

可信自动验收示例：

```typescript
const testGate: Mechanism = {
  name: "test-gate",
  failurePolicy: "fail-graph", // 验收基础设施异常或超时时不要静默放行
  async validateCompletion(ctx) {
    const test = await ctx.exec.run("npm", ["test"], { timeoutMs: 60_000 });
    if (test.code !== 0) {
      return { action: "reject", reason: "真实单元测试未通过" };
    }
    return {
      action: "allow",
      verifiedResult: { exitCode: test.code, output: test.stdout },
    };
  },
};
```

AI 即使在 `result` 中写入 `{ testsPassed: 999 }` 或伪造 `verifiedResult`，也不会覆盖 Runtime 顶层生成的 `completion.verifiedResult.checks`。

结构化上下文示例：

```typescript
ctx.context.append([
  { type: "text", text: "请参考下面的截图" },
  { type: "image", data: base64Data, mimeType: "image/png" },
]);
```

Mechanism 只能提供内容。消息的 `customType/details/display/triggerTurn` 由 SDK 固定，无法借此伪造 NodeScope 或触发额外 turn。`ctx.pi` 仍完整保留，使用裸 pi 时由机制作者自行承担相应生命周期和冲突责任。

`ctx.pi` 继续提供完全定制能力，例如直接注册原生事件：

```typescript
const toolAuditor: Mechanism = {
  name: "tool-auditor",
  onNodeEnter(ctx) {
    const nodeId = ctx.node.id;
    ctx.pi.on("tool_result", (event) => {
      if (!ctx.scope.isActive()) return;
      auditLog.write({ nodeId, tool: event.toolName });
    });
  },
};
```

> `pi.on()` 返回 `void`，没有 `off`。上例的底层监听器会保留到 Session 结束；`isActive()` 只让旧 handler 静默，不会移除它。**推荐优先使用 `ctx.events` 获取 scope 托管的订阅生命周期**——事件在 scope 关闭时自动取消，不积累底层监听器，handler 失败还受 `failurePolicy` 保护。裸 `ctx.pi` 的消息、额外 turn、工具修改和后台任务同样由机制作者自行负责。

---

### Edge（边）

```typescript
interface Edge {
  id: string;
  from: string;
  to: string | typeof END;
  priority: number;
  guard(completion: NodeCompletion): boolean;         // 条件
  migrate(instance, completion): MigrationResult;      // 折叠栈帧 + 生成后继输入
}
```

| 部分        | 作用                                                                           |
| ----------- | ------------------------------------------------------------------------------ |
| `guard`   | 读`NodeCompletion`，判断是否走这条边                                         |
| `migrate` | 把 completion 折叠为`ContextFrame`（推入帧栈），可选生成下一节点的 `input` |
| `to`      | 目标节点，`END` 为终止标记                                                   |

### Router（路由策略）

```typescript
type RouterStrategy =
  | { kind: "first-match" }         // 按 edges 顺序取第一条满足 guard 的
  | { kind: "priority-first" }      // 取 priority 最高者
  | { kind: "custom"; fn: RouterFn } // 自定义函数
  | { kind: "agent-choice" };       // agent 通过 chosen_edge_id 选边
```

---

## 创建节点

Node 有两个 kind：

| kind        | 含义                                                         |
| ----------- | ------------------------------------------------------------ |
| `"code"`  | JS 函数。execute 内可以调`ctx.runAgent()`，来执行agent操作 |
| `"graph"` | 引用另一个 Graph 作为子图，Runtime 自动委托子图执行          |

---

### code 节点：三种典型写法

**同一个 `kind: "code"` 节点，execute 函数体内自由组合代码和 agent**。

#### agent-only（只有 LLM 推理）

```typescript
execute: createAgentExecute({
  skill: "review-grade",
  prompt: (input) => `请批改：${input.data.question}`,
})
```

`createAgentExecute` 是语法糖——等价于 `execute = (_, input, ctx) => ctx.runAgent({ prompt, skill })`。

> **注意**：agent 需要知道的信息必须在 `prompt` 中显式传入。框架不会自动 dump `input.data` 进上下文。如果你用 `createAgentExecute` 不带 `prompt`，agent 只能看到 CURRENT 段的 subGoal 和 skill 名。

#### code-only（只走代码，不调 LLM）

```typescript
execute: async (_instance, input, _ctx) => {
  fs.writeFileSync(input.data.path, JSON.stringify(input.data.payload));
  return { nodeId: "save", status: "ok", result: { saved: true } };
}
```

不需要 `callTool`，不需要 pi 的工具系统。`execute` 就是普通 async 函数，可以用任何 Node.js 或第三方库。

#### hybrid（代码 + agent 穿插）

```typescript
execute: async (instance, input, ctx) => {
  // 代码侧准备
  const fileContent = fs.readFileSync(input.data.filePath, "utf-8");
  const schema = await externalAPI.getValidationSchema();

  // agent 推理
  const result = await ctx.runAgent({
    prompt: `按以下 schema 校验数据：
${JSON.stringify(schema)}

数据：
${fileContent}`,
    skill: "review-grade",
  });

  // 代码侧善后
  if (result.status === "ok") {
    fs.writeFileSync(input.data.outputPath, JSON.stringify(result.result));
  }
  return result;
}
```

#### 完成度验证

验证函数可以声明在节点上（`validateCompletion`），也可以写在 `ctx.runAgent({ validateCompletion })` 里：

```typescript
execute: createAgentExecute({
  validateCompletion(result) {
    if (!result.score) return { isValid: false, reason: "缺少 score" };
    return { isValid: true };
  },
}),
```

验证不通过时，引擎自动注入重试消息让 LLM 继续工作。

### graph 节点（子图）

`kind: "graph"` 节点引用另一张图作为子节点，运行时按 `boundary` 决定执行边界：

```typescript
// 缺省 boundary: "call" — 新 AgentInstance，帧栈隔离
const subCall: Node = {
  kind: "graph",
  id: "sub_call",
  subGoal: "委托子图处理（隔离栈）",
  graph: mySubGraph,
};

// 显式 boundary: "compose" — 复用父 AgentInstance，帧段归约
const subCompose: Node = {
  kind: "graph",
  id: "sub_compose",
  subGoal: "以图代点（共享帧栈）",
  graph: mySubGraph,
  boundary: "compose",
  fold: ({ segment, finalResult }) => ({
    status: finalResult.status,
    result: { childResult: finalResult.result },
  }),
};
```

三种边界的区别：

| 边界 | AgentInstance | frames | 返回 |
|------|--------------|--------|------|
| `call`（默认） | 新建 | 隔离，`frames=[]` | 仅 status/result |
| `compose` | 复用父 Instance | 共享父 frames，子图帧段强制归约 | fold 后截断 |
| `delegate` | 新建 + 新 Session | 物理隔离 | 仅 GraphRunResult |

父图只看调用结果（`NodeCompletion`），不偷看子图内部历史。

---

## skill 集成

### 机制

`node.skill` 是一个单值引用。节点进入时 SDK 先异步调用 `skillProvider` 获取正文，再调用同步 `skillRenderer` 生成模型消息，最后与 NodeScope 一起追加到消息流。严格作用域投影将其归入当前节点的 active 段；节点完成后该段随 ReAct 被帧摘要折叠，不泄漏到下一节点。NodeScope 缺失时投影 fail closed，不会回退外层完整 transcript。

底层使用 `sendMessage({ display: false })`（不触发额外 LLM turn），遵守"追加不注入"原则。

图节点运行期间如果 pi 发生自动、手动或 overflow compaction，SDK 将 pi 原生 `compactionSummary` 与 recent messages 视为压缩历史的权威替代，并推进 frame 投影基线。若当前 NodeScope 已被压缩，投影会在 summary 后恢复 CURRENT；不会重发 checkpoint 后再遮挡压缩结果。

这一规则只适用于 root-only 图。共享 Session 的嵌套 `call/compose` 活跃时，SDK 会在 `session_before_compact` 取消本次压缩：pi 的 compaction summary 基于原始 session entries，可能同时包含父上下文和子图内部 transcript，事后补发调用锚点无法安全拆开。需要独立 compaction 生命周期或可能运行很久的子任务，应使用 `delegate` 边界。

如果取消策略因竞态或其他 extension 异常失效、嵌套调用仍收到 `session_compact`，SDK 会把它视为隔离违规：终止当前共享调用，并在该 session 后续模型投影中移除 compactionSummary。该路径优先保证不泄漏，代价是丢失压缩摘要；不会重发 `call_start` 来宣称边界已经恢复。

### 默认文件位置与自定义来源

`skillBasePath/{skill名称}/SKILL.md`。默认 `skillBasePath` 为 `cwd/skills`，可通过 `createLoopGraphExtension(pi, { skillBasePath: "..." })` 配置。SDK 通过 `resources_discover` 事件将 `skillBasePath` 注册到 pi 的原生 skill 系统，pi 自动扫描 frontmatter 并在系统提示中以 XML 形式列出可用 skill。

业务也可以从数据库或远程服务加载：

```typescript
createLoopGraphExtension(pi, {
  async skillProvider(ref, context) {
    return await skillDatabase.load(ref, context.input.data.tenantId);
  },
  skillRenderer(_ref, content) {
    return { kind: "skill", content: `业务规则：\n${content}` };
  },
  skillFailure: {
    missing: "fail",
    error: "fail",
  },
});
```

provider 和 renderer 接收只读快照，不能修改 Runtime。自定义 `skillRenderer` 接管展示后，默认 CURRENT 不再重复显示内部 skill ref；返回 `null` 会同时隐藏默认 skill 名称和正文。`missing/error: "ignore"` 会记录诊断并继续，`"fail"` 会终止当前图。

### 多 skill 支持

**当前状态**：一个节点一次只能关联一个 skill（`node.skill?: string` 单值字段）。图级 `skills?: string[]` 数组未实现。

如果你需要在一个节点中使用多个 skill，有以下策略：

| 策略                             | 做法                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **拆到不同节点**           | 将不同 skill 的任务拆成多个串行/并行节点，各自的`node.skill` 指向不同的 skill                                                                                                             |
| **手动组合 prompt**        | 在`createAgentExecute({ prompt: input => ... })` 中自行读取并合并多个 skill 文件内容到 prompt 中                                                                                          |
| **纯代码绕过**             | `kind: "code"` 节点的 `execute` 是普通 async 函数，可以直接 import 和调用任何 domain 代码，不依赖 `node.skill` 机制                                                                   |
| **节点级 tools（最常用）** | 大多数场景下，你需要的不是多 skill，而是在当前节点附加一组专用工具。声明`tools: ["tool_a", "tool_b"]`，配合 `prompt` 字段告知 agent 如何协作即可。`tools` 和 `skill` 可以同时使用。 |

如果一条图中不同节点需要不同的 skill，这是完全支持的——每个节点声明各自的 `node.skill` 即可。

### 投影中的 skill 行

使用默认 provider/renderer 时，CURRENT 保留 `skill: {名称}`，正文使用 `[skill: name]` 包装。使用自定义 skill renderer 时，展示完全由业务 renderer 决定。projection 仍是纯函数，不接触 IO。

---

## 边和路由

### 基础用法

```typescript
const okEdge: Edge = {
  id: "to_next",
  from: "grade",
  to: "summary",
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `得分: ${completion.result.score}`,
        result: completion.result,
      },
      input: { score: completion.result.score },
    };
  },
};

const failedEdge: Edge = {
  id: "to_retry",
  from: "grade",
  to: "grade",               // 自环：重回本节点
  priority: 5,
  guard: (c) => c.status === "failed",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: "ok",
        summary: "用户答错，准备重试",
        result: completion.result,
      },
      input: { retry: true },
    };
  },
};
```

```typescript
routing: {
  grade: {
    nodeId: "grade",
    edges: [failedEdge, okEdge],  // 先匹配失败边，再匹配成功边
    router: { kind: "priority-first" },  // 按 priority 排序，同级按数组顺序
  },
},
```

### 无边匹配

当 `selectEdge` 找不到满足 `guard` 的边时，图会优雅结束（不 throw），推入一帧标记失败原因。

### agent-choice

`{ kind: "agent-choice" }` 让 agent 在 `__graph_complete__` 时通过 `result.chosen_edge_id` 声明选择哪条边。单边匹配时直接返回；多边匹配时读取 `chosen_edge_id`，未声明或声明了不存在的边时由 `validateCompletion` 驳回机制列出所有可选边让 agent 重试（`priority-first` 仅为防御性兜底，正常路径不会执行到）。

---

## 图调用协议（GraphRunRequest / GraphRunResult）

所有图调用（命令、工具、父图节点）统一为 `GraphRunRequest → GraphRunResult` 协议，由入口类型和执行边界正交组合：

```typescript
type GraphInvocationKind = "command" | "tool" | "graph-node" | "api";
type GraphInvocationBoundary = "compose" | "call" | "delegate";

interface GraphRunRequest {
  background: Record<string, unknown>;
  invocationKind: GraphInvocationKind;
  boundary: GraphInvocationBoundary;
  signal?: AbortSignal;
}

interface GraphRunResult {
  graphId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
  steps: number;
}
```

`GraphRunResult` 不包含 frames、ReAct 或 trace——业务返回与审计历史分离。业务 `failed/cancelled` 正常返回；基础设施异常（host 创建失败、工具缺失等）直接 throw。

## Compaction 协同

### root-only 图

SDK 监听 `session_compact` / `session_before_compact`，推进 frame 投影基线。pi 原生 `compactionSummary` 与 recent messages 是压缩历史的权威替代：压缩前已有 frames 不再重复投影，新 frames 从压缩基线继续生长。SDK 不重发 NodeScope，不遮挡 summary。

### 嵌套 call/compose 共享 session

嵌套 `call/compose` 活跃期间，SDK 在 `session_before_compact` 返回 `{ cancel: true }` 取消压缩。因为 pi compaction 基于原始 session entries（而非 SDK 投影后的消息），可能把父上下文和子图内部 transcript 混合进无法拆分的摘要。

如果取消策略因竞态异常失效，SDK fail-closed：终止当前共享调用，过滤已污染的 compactionSummary，不会重发 `call_start` 假装恢复。

需要独立 compaction 生命周期的长任务应使用 `delegate` 边界（通过 `DelegateGraphInvoker` 在独立子会话中执行）。

---

## 完成度验证

### outputSchema

`AgentRunRequest.outputSchema` 已接入 Runtime。可通过 `createAgentExecute` 声明：

```typescript
execute: createAgentExecute({
  outputSchema: {
    type: "object",
    properties: {
      score: { type: "number" },
      explanation: { type: "string" },
    },
    required: ["score", "explanation"],
  },
})
```

结果不符合 schema 时节点不会退出，而是向模型发送 retry 消息。校验顺序固定为：

```text
outputSchema → runAgent validator → Node.validateCompletion → agent-choice
```

前一层失败时后续层不会执行。

节点声明 `validateCompletion` 函数，引擎在 `__graph_complete__` 调用时自动执行：

```typescript
validateCompletion(result) {
  if (!result.question) return { isValid: false, reason: "缺少 question" };
  if (!result.options || result.options.length < 2)
    return { isValid: false, reason: "选项应至少 2 个" };
  return { isValid: true };
}
```

**流程**：

1. LLM 调 `__graph_complete__({ status: "ok", result: { question: "1+1=?", options: ["2"] } })`
2. 验证发现 `options.length < 2` → 不通过
3. 引擎自动注入一条消息："验证未通过: 选项应至少 2 个。请修正后再次调用 __graph_complete__"
4. LLM 收到后补充选项，再次上报
5. 验证通过 → 路由 → 下一节点

**注意**：验证只在 `completion.status === "ok"` 时执行。`failed` 和 `cancelled` 不验证，直接进入路由。

### 自定义恢复与完成反馈

```typescript
createLoopGraphExtension(pi, {
  modelMessageFormatter: {
    validationRetry: ({ reason }) => `结果需要修改：${reason}`,
    graphFailure: ({ graphId, reason }) => `流程 ${graphId} 已终止：${reason}`,
  },
  completionToolResultFormatter: ({ status, result }) =>
    `阶段状态：${status}；已收到 ${Object.keys(result).length} 个字段`,
});
```

这些 formatter 只改变模型看到的文字。`__graph_complete__` 名称、三种状态、result/details 和 Runtime 退出规则保持固定。

---

## 子图（call 与 compose）

`kind: "graph"` 缺省使用 `call`：复用当前 AgentSession/Runtime，但创建新的 `AgentInstance`，因此 `frames`、`scratch` 和 global mechanisms 都与父图隔离；调用点的 `NodeInput.data` 成为 child background。root 图和 call 子图共用 call stack，child NodeScope 的 `depth` 会增加，返回后工具集、父 CallFrame 和父节点作用域都会恢复。

需要把图作为“替代一个点”的代码组织手段时，显式使用 `boundary: "compose"`。它复用父 `AgentInstance`：child 可见父已完成 frames、共享 scratch，并在同一帧栈上运行；但 child 的 Graph.goal / mechanisms 只在其 CallFrame 内有效。child 新增的全部 frames 是受 Runtime 管理的临时段，退出时**一定**由 `fold`（或默认 fold）归约，父图只留下 graph node 经 Edge.migrate 写入的一帧，内部 ReAct 不会泄漏。

`fold` 收到的是独立、冻结的帧段快照和 child `GraphRunResult`；默认 fold 仅返回 child 的 `status/result`。业务 `failed`/`cancelled` 同样执行 fold；节点、fold 或运行基础设施错误会回滚临时段并继续抛出。`delegate` 通过 `DelegateGraphInvoker` 在独立子会话中执行。`call/delegate + fold`、缺少 delegate host 和嵌套 Graph 循环引用仍在校验阶段报错。

```typescript
const childGraph: Graph = {
  id: "child",
  goal: "子任务",
  entries: [entry],
  nodes: { step1, step2 },
  routing: { ... },
};

// 父图中引用：
const graphNode: Node = {
  kind: "graph",
  id: "invoke_child",
  subGoal: "委托子图处理",
  graph: childGraph,
  boundary: "compose",
  fold: ({ segment, finalResult }) => ({
    status: finalResult.status,
    result: { child: finalResult.result, completedNodes: segment.map((frame) => frame.nodeId) },
  }),
};
```

**边界保证**：

- `call`：父 frames/scratch 对 child 不可见；child 最终 result 归约为父 graph node completion。
- `compose`：child 可读父 frames 并共享 scratch；child 内部 frames 在退出时被截断，只有开发者在 fold 中显式传出的数据才会跨组合边界。
- 两种边界都由父图的 Edge 决定如何把 graph node completion 折叠进父图帧栈。

---

## 帧栈与投影

### 帧栈是什么

`AgentInstance.frames` 是一个数组，按时间顺序存储已折叠的节点执行历史。每个 `ContextFrame`：

```typescript
interface ContextFrame {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  summary: string;
  result: Record<string, unknown>;
}
```

### 投影是什么

每次 LLM 调用前，`context` 钩子将当前消息重组：已完成节点的原始 ReAct 被丢弃，由帧摘要（COMPLETED 段）顶替；当前节点的 live 消息保留。

### 作用域匹配

projection 不再依赖随机哨兵切分消息数组。Runtime 进入节点时追加一条语义化 `loop_graph_node_scope` 消息（`customType`），其 `content` 含 CURRENT 信息、`details` 含结构化 `NodeScopeDescriptor`（scopeId、graphRunId、instanceId 等）。projection 从尾部匹配当前 scopeId：

```typescript
const scopeIdx = findLastMatchingScope(messages, activeScope);
if (scopeIdx >= 0) {
  return [formatFrames(frames), ...messages.slice(scopeIdx)];
}
// fail closed: 输出 frames + 确定性 CURRENT
```

找不到 scope 时**不回退**完整原始 transcript，只输出帧摘要 + 从当前节点重建的 CURRENT（fail-closed），并记录结构化诊断。

默认格式（向后兼容）：

```
=== COMPLETED ===
[{"nodeId":"...","status":"ok","summary":"...","result":{...}}]
=== END ===
=== CURRENT ===
nodeId: ...
subGoal: ...
=== END ===
（当前节点的 live ReAct 消息）
```

### 自定义帧格式

通过 `frameFormatter` 选项，开发者完全控制 COMPLETED 段的格式与内容：

```typescript
const loop = createLoopGraphExtension(pi, {
  frameFormatter: (frames) => {
    // 返回 null → 跳过 COMPLETED 段（完全不折叠）
    // 返回 string → 作为 COMPLETED 段完整文本注入上下文

    return frames
      .map((f) => {
        const kv = Object.entries(f.result)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        return `[${f.nodeId}] ${f.status}\n${kv}`;
      })
      .join("\n\n");
  },
});
```

注入效果：

```
[generate_question] ok
  question: 二叉树的前序遍历是什么？
  difficulty: easy

[grade_answer] ok
  is_correct: true
  explanation: 回答正确
```

不传 `frameFormatter` 时保持默认 JSON 格式（向后兼容）。

### 什么时候推帧

`Edge.migrate` 返回的 `frame` 被推入帧栈。开发者通过 `migrate` 控制每帧的 `summary` 和 `result`：

```typescript
migrate(instance, completion) {
  return {
    frame: {
      nodeId: "generate_question",
      status: "ok",
      summary: `已生成题目 ${completion.result.question_id}`,
      result: completion.result,
    },
  };
}
```

`summary` 只允许纯字符串（框架不调用 LLM 优化）。如果需要自然语言摘要，开发者自己决定在 migrator 中调用 LLM。

---

## NodeCompletion

```typescript
interface NodeCompletion {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
}
```

| 字段       | 说明                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `nodeId` | 当前节点 ID                                                                |
| `status` | 完成状态                                                                   |
| `result` | 产出的结构化数据。`Record<string, unknown>` 不做类型约束，开发者自行保证 |

---

## 入参体系

### NodeInput

```typescript
interface NodeInput {
  data: Record<string, unknown>;    // 当前节点的一次性入参
  source:
    | { kind: "entry"; entryId: string }                // 来自入口
    | { kind: "edge"; edgeId: string; fromNodeId: string }; // 来自边
}
```

### 节点间传递

```
Edge.migrate 的 input 字段 → 下一节点的 NodeInput.data
```

`input` 只传递给直接后继节点。如果后续节点需要某些信息，必须在 `result` 中产出，经 `Edge.migrate` 折叠进帧。

### GraphInvocation 与命令入参

```typescript
interface GraphInvocation {
  name: string;                          // 命令名（/xxx）和工具名
  description: string;
  inputSchema: Record<string, unknown>;  // 工具入参 schema（agent tool-call 用）
  parseArgs?(args: string): Record<string, unknown>; // 命令调用：把裸文本解析为结构化入参
}
```

当用户输入 `/hello 世界` 时：

1. `GraphRegistry` 调用 `inv.parseArgs("世界")`，产出 `{ subject: "世界" }`
2. `params` 随 trigger 传入 `executeGraph`
3. `executeGraph` 以 `params` 构造 `background` → `Entry.guard(background)` → `Entry.mapInput(background)`

如果 `parseArgs` 未定义，命令 handler 默认传入 `{ args: rawString }`。

---

## 调试

运行后项目根目录生成 `loop-graph-debug.log`（JSONL 格式）：

```bash
tail -f loop-graph-debug.log  # 实时观察
```

关键事件：

| 事件               | 查看内容                         |
| ------------------ | -------------------------------- |
| `enter_node`     | 节点 ID、输入数据、当前帧栈      |
| `projection`     | 消息总数、scopeId 是否命中、帧数 |
| `agent_complete` | 完成状态、result 字段列表        |
| `exit_node`      | 推入的帧摘要、累计帧数           |
| `agent_retry`    | 验证不通过的原因                 |

---

## 完整示例

一个两节点复习图：选择科目 → 生成题目 → END。

```typescript
import { END, createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";

// ── 节点 ──

const selectNode: Node = {
  kind: "code",
  id: "select_target",
  subGoal: "选择科目和模式",
  tools: ["review_chapter", "review_exam_points"],
  execute: createAgentExecute({ tools: ["review_chapter", "review_exam_points"] }),
};

const questionNode: Node = {
  kind: "code",
  id: "generate_question",
  subGoal: "生成一道符合约束的结构化题目",
  skill: "review-question",
  tools: ["review_card"],
  execute: createAgentExecute({ skill: "review-question", tools: ["review_card"] }),
  validateCompletion(result) {
    if (!result.question_text) return { isValid: false, reason: "缺少 question_text" };
    if (!result.options || result.options.length < 2) return { isValid: false, reason: "选项应至少 2 个" };
    return { isValid: true };
  },
};

// ── 边 ──

const selectToQuestion: Edge = {
  id: "sel_to_q",
  from: "select_target",
  to: "generate_question",
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `已选择: ${completion.result.subject} / ${completion.result.mode}`,
        result: completion.result,
      },
      input: { subject: completion.result.subject, mode: completion.result.mode },
    };
  },
};

const questionDone: Edge = {
  id: "q_to_end",
  from: "generate_question",
  to: END,
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `已生成题目: ${completion.result.question_text?.slice(0, 40)}`,
        result: completion.result,
      },
    };
  },
};

// ── 入口：parseArgs 将 /r 数学 → { subject: "数学" }，直接作为 background ──

const entry: Entry = {
  id: "review_cmd",
  guard: (bg) => typeof bg.subject === "string" && bg.subject.length > 0,
  startNodeId: "select_target",
  mapInput: (bg) => ({ subject: bg.subject }),
};

// ── 图 ──

export const reviewGraph: Graph = {
  id: "quick_review",
  goal: "快速生成复习题目",
  invocation: {
    name: "r",
    description: "快速复习",
    inputSchema: { type: "object", properties: { subject: { type: "string" } } },
    // parseArgs 将 /r 数学 → { subject: "数学" }，直接作为 background
    parseArgs: (a) => ({ subject: a || "" }),
  },
  entries: [entry],
  nodes: { select_target: selectNode, generate_question: questionNode },
  routing: {
    select_target: {
      nodeId: "select_target",
      edges: [selectToQuestion],
      router: { kind: "first-match" },
    },
    generate_question: {
      nodeId: "generate_question",
      edges: [questionDone],
      router: { kind: "first-match" },
    },
  },
};
```

---

## 限制

| 项 | 当前策略 |
| --- | -------- |
| schema 辅助工具 | `NodeCompletion.result` 保持 `Record<string, unknown>` |
| session 续跑 | 帧栈未持久化到磁盘 |
| 同 instance root 并发 | `executeGraph()` fail-fast；并发任务使用独立 delegate host |
| 单节点 skill 数量 | `node.skill?: string`，一次只关联一个 skill 引用 |
| delegate host | 独立 Session 执行载体；需业务 extension 提供 `createDelegateHost` 工厂 |
| 失败边处理 | `selectEdge` 返回 null 时优雅结束 |
