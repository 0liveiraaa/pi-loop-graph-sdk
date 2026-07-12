# Loop Graph SDK 开发者指南

## 概要

Loop Graph SDK 是一个基于 pi 的 agent 编排框架。

**核心模型**：一个图（Graph）由节点（Node）、边（Edge）和路由策略（Router）组成。Agent 在图中流动——进入一个节点执行任务、完成后通过边迁移到下一个节点、重复直到终点（END）。

**关键特性**：

- **历史自动摘要**：已完成节点内部的 LLM 推理过程被自动压缩为简短摘要，后续节点只看到结果摘要，不看到原始展开过程
- **三种子图调用方式**：`call`（创建独立工作区，历史隔离）、`compose`（共享当前工作区，结束后压缩为单条记录）、`delegate`（创建完全独立的会话，物理隔离）
- **不干预 LLM 推理**：框架只编排"什么时候执行什么节点"，不干涉节点内部的 LLM 推理循环
- **全员函数扩展**：所有定制点都是函数（`guard`、`migrate`、`execute`、`validateCompletion`、`custom router`），无黑盒限制
- **无隐式全局状态**：所有跨节点数据通过上下文记录显式传递，不依赖闭包或模块变量
- **不修改 system prompt**：所有附加信息以追加消息的方式进入对话流，不影响 pi 原生的提示管理

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

`nodeId/status/summary/result` 仍可用于旧图，但不再是必填字段。END 边推荐使用 `output` 声明对外返回，不要让工作记忆兼做函数返回通道。

当 LLM 上下文因长度限制被 pi 自动压缩时，已压缩的旧帧不再重复出现在后续节点的上下文中，新帧从压缩后的位置继续累积。开发者无需在帧中记录任何压缩元数据。

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
   *  默认保持 JSON 格式。参见 §历史与上下文。 */
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

`contextRenderer` 控制节点进入时 SDK 主动追加给 LLM 的内容。它不访问完整对话历史，也不影响子图消息清洗或上下文压缩的内部逻辑：

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

这样 LLM 不再默认看到 nodeId、工具名、skill 名、边信息或 `=== CURRENT ===` 标签。renderer 可以读取：

- 当前图、当前节点和一次性入参；
- 节点进入时的历史摘要快照；
- agent-choice 的可选边；
- 已加载的 skill 正文；
- 固定的完成协议名称和状态。

renderer 是同步函数，每个节点每次进入只调用一次。传入的 graph/node/input/history 是只读快照——修改它们不影响实际运行。返回值分为主要内容和附加内容，SDK 会复制并冻结文本。当 LLM 上下文被压缩后重新展开时，复用的是第一次生成的结果，不会重新调用 renderer。返回 `null` 或 `anchor: null` 表示不展示节点指引正文，但 SDK 内部仍需保留必要的会话标记以正确恢复上下文。

历史摘要仍由 `frameFormatter` 控制。如果同时自定义两者：

```typescript
createLoopGraphExtension(pi, {
  frameFormatter: (frames) => renderBusinessMemory(frames),
  contextRenderer: (input) => ({ anchor: { content: renderCurrentTask(input) } }),
});
```

未提供 `contextRenderer` 时，使用默认格式：`=== CURRENT ===` + `[skill: 名称]`。

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

调用级 renderer 沿同一会话的 `call`/`compose` 子图传播。`delegate` 创建独立 AgentSession，不隐式继承调用配置；需要在创建隔离 session 的工厂中声明其 renderer。任何 renderer 抛错都会让图终止，不回退到默认格式或原始对话内容。

所有限制值必须是有限正整数，非法值会在 `createLoopGraphExtension()` 时报错。`rootMaxSteps` 控制顶层图的最大步骤数；`childMaxSteps` 控制 `call`/`compose` 子图的最大步骤数。delegate 图在独立宿主中运行，使用该宿主创建时传入的限制值。

同一个 `LoopGraphExtension` 实例不支持同时多次调用 `executeGraph()`。第二个调用会立即报错；需要并发时应为每个任务创建独立的 delegate host。同一个 pi Session 上创建另一个 extension 实例不代表事件隔离，不能作为并发方案。图内部的嵌套 `call`/`compose` 不属于并发。

`defaultTools` 在注册期通过 `resolveNodeTools` 与每个节点的 `tools` 合并并去重：

```text
最终工具集 = read + defaultTools ∪ node.tools + __graph_complete__（去重，read 强制首位）
```

这样业务包不需要在每个节点重复声明全局可用工具。

需要按 graph/node、运行环境或权限策略决定候选工具时，可配置 `toolResolver`：

```typescript
const loop = createLoopGraphExtension(pi, {
  toolResolver({ defaultTools, nodeTools, graphId, nodeId }) {
    return policy.resolve({ defaultTools, nodeTools, graphId, nodeId });
  },
});
```

resolver 的返回会统一去重；`read` 与 `__graph_complete__` 仍由 SDK 强制放在首尾。相同 resolver 同时用于首次工具存在性校验和实际 `setActiveTools()`，避免“校验一套、运行另一套”。

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
节点进入
→ 全局机制（Graph.mechanisms）
→ 子图局部机制（仅 compose 时生效，退出后撤销）
→ 节点局部机制（Node.mechanisms）
→ 节点主体执行
  → beforeAgentRun（每次 runAgent 前）
  → [onTurnStart → beforeToolCall → 工具执行 → afterToolResult/onToolResult → onTurnEnd] × N
  → validateCompletion × N（驳回时继续下一轮 LLM 推理）
→ onNodeExit（边选择之前）
→ 节点会话关闭（abort 信号 + 逆序清理 + 取消事件订阅）
```

规则：

- 全局机制写在 `Graph.mechanisms`，所有节点都生效。
- compose 子图的 `Graph.mechanisms` 只在该子图执行期间生效，退出后自动撤销。
- 局部机制写在 `Node.mechanisms`，只叠加到当前节点。
- `onNodeEnter` 串行执行；抛错记录日志后继续，不中止节点。
- 每次 `runAgent()` 分配独立 ID；同一节点连续调用时，事件不会串到上一轮。
- `beforeToolCall` 的 patch 按机制顺序组合并重新校验工具参数；无可靠 schema 时拒绝 patch。`__graph_complete__` 不走一般 patch。
- `afterToolResult` 只能替换 LLM 可见的 `content/isError`，不能改元数据。
- `validateCompletion` 只在状态为 `ok` 时执行；可 allow、reject、fail-node 或 fail-graph。
- `onNodeExit` 在节点完成后、边选择前串行执行，收到只读快照。
- 节点会话任意阶段抛错时调用 `onNodeError`；它只观察原始错误，不能替换。
- 未声明任何 Hook 的 mechanism 被跳过。
- cleanup 按注册逆序执行；一个 cleanup 抛错不阻止其他 cleanup，也不覆盖原始错误。

失败策略：

| `failurePolicy` | Hook 抛错后的行为 |
| --- | --- |
| `continue` | 记录日志并继续（默认值） |
| `fail-node` | 框架生成可信的失败完成信号，跳过节点主体并交给路由 |
| `fail-graph` | 终止当前图，但仍执行 `onNodeError` 和全部 cleanup |

同一阶段多个机制发生控制性失败时，全部 Hook 仍按顺序执行，最终优先级为 `fail-graph > fail-node > continue`。`onNodeError` 自身抛错只作为次级诊断。

两层能力面：

| 通道 | 作用 | 框架保证 |
| --- | --- | --- |
| `ctx.scope` | 取消信号、活跃检查、清理注册 | 与当前节点会话同生共死 |
| `ctx.events` | 事件订阅（onToolResult/onTurnStart/onTurnEnd） | 每类事件只注册一次底层监听器；节点会话关闭时自动取消订阅；handler 失败进入 failurePolicy |
| `ctx.state` | 类型化私有状态，由 `createState()` 懒初始化 | 按工作区 + 机制对象身份隔离；call 创建新状态，compose 复用；不入 LLM 上下文 |
| `ctx.exec.run()` | 执行外部命令 | 自动绑定 scope signal；限制 timeout 和输出大小 |
| `ctx.decisions.list()` | 读取工具决策记录 | 返回当前会话内的只读 trace |
| `ctx.context.append(content)` | 向 LLM 追加文本或图片内容 | 固定消息类型；节点会话失效后返回 false，不会污染后续节点 |
| `ctx.instance.scratch` | 共享横切状态（兼容） | 随工作区生命周期 |
| `ctx.pi` | 完整 pi 能力 | 仅保证 API 可用；副作用不自动获得清理保证 |

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

Mechanism 只能提供内容。消息的 `customType/details/display/triggerTurn` 由 SDK 固定，无法借此伪造节点会话标记或触发额外 LLM 轮次。`ctx.pi` 仍完整保留，使用裸 pi 时由机制作者自行承担相应生命周期和冲突责任。

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

`node.skill` 是一个单值引用。节点进入时 SDK 先异步调用 `skillProvider` 获取正文，再调用同步 `skillRenderer` 生成 LLM 可见的消息，最后与节点指引一起追加到对话流。节点完成后该消息不再进入后续节点上下文。

底层使用 `sendMessage({ display: false })`（不触发额外 LLM 轮次），遵守"追加不注入"原则。

如果在节点运行期间发生上下文压缩，SDK 将 pi 的压缩摘要和最近消息视为压缩历史的权威替代，从压缩位置继续累积新帧。不会重新发送节点指引来遮挡压缩结果。

这一规则只适用于独立图。嵌套 `call`/`compose` 活跃时，SDK 会在压缩前尝试取消：pi 的上下文压缩基于原始对话条目，可能同时包含父上下文和子图内部对话，事后补发调用标记无法安全拆开。需要独立压缩生命周期或可能运行很久的子任务，应使用 `delegate` 边界。

如果取消策略因竞态或其他 extension 异常失效，SDK 会终止当前共享调用并清除已被污染的压缩摘要，优先保证信息不泄漏。不会重新发送调用来宣称边界已经恢复。

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

### Skill 在上下文中的展示

使用默认 provider/renderer 时，节点指引段显示为 `skill: {名称}`，skill 正文以 `[skill: name]` 格式包裹。使用自定义 skill renderer 时，展示完全由业务 renderer 决定。

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

## 上下文压缩协作

### 独立图

LLM 上下文长度超限时，pi 自动压缩历史。压缩后，pi 的压缩摘要和最近消息是压缩历史的权威替代：压缩前的历史帧不再重复出现，新帧从压缩后的位置继续累积。SDK 不重发节点指引，不遮挡 pi 的压缩摘要。

### 嵌套子图

嵌套 `call`/`compose` 活跃期间，SDK 阻止 pi 压缩。因为 pi 的压缩基于原始对话条目，可能将父上下文和子图内部对话混入无法拆分的摘要。

如果阻止失败，SDK 会终止当前共享调用并清除已被污染的压缩摘要，优先保证信息不泄漏。

需要独立压缩生命周期的长任务应使用 `delegate` 边界。

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

## 子图（call / compose / delegate）

`kind: "graph"` 节点可以引用另一张图作为子图执行。通过 `boundary` 指定调用方式：

- **`call`（默认）**：复用当前 AgentSession，但创建独立工作区。子图看不到父图的执行历史和共享状态；子图结果归约为一个节点完成信号。
- **`compose`**：共享父图的工作区。子图可以读取父图的已完成历史，子图新增的历史在退出时由 `fold` 函数压缩为一条记录。适合"以图代点"的代码组织。
- **`delegate`**：创建完全独立的 AgentSession。物理隔离，适合长任务或需要独立上下文压缩的场景。需要配置 `createDelegateHost`。

```typescript
const childGraph: Graph = {
  id: "child",
  goal: "子任务",
  entries: [entry],
  nodes: { step1, step2 },
  routing: { ... },
};

// 父图中引用（compose 方式）：
const graphNode: Node = {
  kind: "graph",
  id: "invoke_child",
  subGoal: "委托子图处理",
  graph: childGraph,
  boundary: "compose",
  fold: ({ segment, finalResult }) => ({
    status: finalResult.status,
    result: { child: finalResult.result, completedNodes: segment.map((f) => f.nodeId) },
  }),
};
```

**边界保证**：

| 方式 | 工作区 | 历史可见性 | 返回结果 |
|------|--------|-----------|----------|
| `call`（默认） | 新建 | 仅参数 | 仅 status/result |
| `compose` | 共享 | 父已完成历史 | fold 后截断 |
| `delegate` | 新建 + 新会话 | 仅参数 | 仅 GraphRunResult |

---

## 历史与上下文

### 节点执行历史

每个工作区维护一个有序数组 `frames`，按时间顺序存储已完成的节点执行摘要。每条摘要是一个 `ContextFrame`：

```typescript
interface ContextFrame {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  summary: string;
  result: Record<string, unknown>;
}
```

### LLM 看到的上下文

每次 LLM 推理前，当前对话被重组为两部分：

1. **历史摘要**：所有已完成节点的原始 LLM 推理过程被移除，只保留 `frames` 中的摘要
2. **当前节点工作区**：当前节点的指引信息和实时推理消息

这样 LLM 既能看到过去的执行结果摘要，又能看到当前正在进行的任务，不会被旧的推理过程分散注意力。

### 自定义历史摘要格式

通过 `frameFormatter` 选项，你可以完全控制历史摘要的格式与内容：

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
  formatToolResult?(result: Readonly<GraphRunResult>): string; // graph tool 的模型可见文本
}
```

当用户输入 `/hello 世界` 时：

1. `GraphRegistry` 调用 `inv.parseArgs("世界")`，产出 `{ subject: "世界" }`
2. `params` 随 trigger 传入 `executeGraph`
3. `executeGraph` 以 `params` 构造 `background` → `Entry.guard(background)` → `Entry.mapInput(background)`

如果 `parseArgs` 未定义，命令 handler 默认传入 `{ args: rawString }`。

`formatToolResult` 只改变 graph 作为工具调用时返回给模型的文本，工具结果 `details` 仍保留完整 `GraphRunResult`。还可通过 Extension 级 `formatToolResult` 设置全局默认值；单个 invocation 的 formatter 优先。所有自定义文本仍受 `toolResultMaxBytes` 限制。

---

## 调试

默认不写任何日志文件。推荐注入结构化 `traceSink` 或 logger：

```typescript
const loop = createLoopGraphExtension(pi, {
  traceSink(event) {
    telemetry.record(event);
  },
  logger: console,
});
```

生命周期事件包括：

- `graph_start/graph_end/graph_error`
- `node_enter/node_exit`
- `compaction`

事件是冻结快照；sink/logger 抛错或异步拒绝不会改变图执行结果。

需要本地 JSONL 调试时显式开启：

```typescript
createLoopGraphExtension(pi, {
  debug: true,
  debugLogPath: "loop-graph-debug.log",
});
```

```bash
tail -f loop-graph-debug.log  # 实时观察
```

关键事件：

| 事件               | 查看内容                         |
| ------------------ | -------------------------------- |
| `enter_node`     | 节点 ID、入参数据、当前历史摘要  |
| `context`        | 消息总数、当前节点是否命中、帧数 |
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
| session 续跑 | 历史记录未持久化到磁盘 |
| 同一实例顶层并发 | `executeGraph()` 立即报错；并发任务应使用独立 delegate host |
| 单节点 skill 数量 | `node.skill?: string`，一次只关联一个 skill 引用 |
| delegate host | 隔离子会话执行载体；需业务 extension 提供 `createDelegateHost` 工厂 |
| 无匹配边 | 节点结束后图优雅终止 |
