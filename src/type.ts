// ============================================================
//  Loop Graph SDK — 核心类型定义
// ============================================================
//
//  栈式子图编排

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
//
//    AgentInstance 持有一个有序帧栈（frames），每进入一个节点就在栈上生长一层，
//    离开节点时边负责折叠栈顶层。栈只增不减，历史不可篡改。
//
//    子图调用是一等公民：Node 可以引用另一个 Graph 作为其实现。
//    子图执行使用隔离栈：Runtime 为子图创建新的 AgentInstance，
//    子图 END 时整段帧归约为父图该 Node 的一次产出。
//    "顶层调用"只是子图调用的一个特例（无调用者）。
//
// ============================================================

// ── 终止标记 ──

/**
 * 图的终止标记，也是图的「返回」出口。
 *
 * 当一条边的 to 指向 END，Runtime 弹出当前图的栈帧，
 * 并将该边 migrate 产出的 frame.result 作为本图的返回值：
 *   · 子图调用   → 成为父图 kind="graph" 节点的 NodeCompletion.result
 *   · tool 调用  → 成为返回给 agent 的工具结果
 *   · 顶层调用   → 成为整次运行的最终产出
 *
 * 即:END 边的 migrate 承担双重身份——既折叠最后一层进历史，
 * 又通过 frame.result 声明「这张图对外交付什么」。
 */
export const END = Symbol("graph.end");

// ── 节点完成信号 ──

/**
 * 节点执行完毕的原始产出。
 */
export interface NodeCompletion {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
}

// ── 栈帧 ──

/**
 * 栈中的一层。每进入一个节点就 push 一帧；
 * 离开节点时由 Edge.migrate 填写 snapshot 将其折叠。
 */
export interface ContextFrame {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  summary: string;
  result: Record<string, unknown>;
}

// ── Agent 实例 ──

/**
 * 回路图中的活动主体，持有一个有序帧栈。
 *
 *   background  — 进入当前图时的背景上下文（不变）
 *   frames      — 有序执行历史，只增不减，只由 Edge.migrate 折叠
 *   mechanisms  — 全局横切机制，跨节点持续生效
 *   scratch     — mechanism 的唯一合法可变区（见下）
 *
 * 阶段性业务状态不挂在 AgentInstance 上。节点只能从 background 和 frames
 * 读取已经显式进入历史的上下文。
 *
 * scratch 的契约（宪法原则 2 的显式例外）：
 *   1. 只有 Mechanism.apply 可写 scratch。execute 可读，不应写——
 *      写了就是绕过声明式机制。
 *   2. scratch 不进 agent 上下文。projection 永不渲染它，
 *      它与 input 同侧（代码侧横切状态）。
 *   3. scratch 随 AgentInstance 生命周期。子图新实例 = 新 scratch，
 *      与 frames 隔离契约一致。
 *   4. 跨节点的业务状态迁移仍走 Edge/frame，不走 scratch。scratch 只承载
 *      横切基础设施的工作状态（计时器起点、重试计数等），不是业务迁移通道。
 */
export interface AgentInstance {
  id: string;
  globalGoal: string;
  background: Record<string, unknown>;
  frames: ContextFrame[];
  mechanisms: Mechanism[];
  scratch: Record<string, unknown>;
}

// ── 节点输入与执行能力 ──

/**
 * 当前节点的一次性入参。
 *
 * Entry 为第一个节点构造 input；Edge.migrate 为后继节点构造 input。
 * input 不属于 AgentInstance 的持久状态，节点若希望后续阶段可见某些信息，
 * 必须在完成信号中产出，并由 Edge 折叠进 ContextFrame。
 */
export interface NodeInput {
  data: Record<string, unknown>;
  source:
    | { kind: "entry"; entryId: string }
    | { kind: "edge"; edgeId: string; fromNodeId: string };
}

/**
 * 节点执行所需的运行时能力。
 *
 * 这里保持框架级抽象，不绑定 pi 的具体 AgentSession 实现。
 * pi extension 适配层负责把 runAgent/callTool 映射到真实会话、工具和 UI。
 */
export interface NodeContext {
  signal: AbortSignal;
  runAgent(request: AgentRunRequest): Promise<NodeCompletion>;
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface AgentRunRequest {
  prompt: string;
  /** @deprecated 工具集由 Node.tools 统一声明。此字段不再生效。 */
  tools?: string[];
  skill?: string;
  outputSchema?: unknown;
  /** 可选：验证 __graph_complete__ 的 result 是否满足节点要求。
   *  不通过 → inject reason → agent 继续 → 再次调用 __graph_complete__ */
  validateCompletion?: (
    result: Record<string, unknown>,
  ) => { isValid: true } | { isValid: false; reason: string };
}



// ── 节点 ──

/**
 * 可运行工作阶段。
 *
 * 普通节点（kind: "code"）和复合节点（kind: "graph"）互斥：
 *   code  → 提供 execute
 *   graph → 提供 graph（子图调用），execute 由 Runtime 自动委托给子图
 *
 * code 节点的执行配置声明在 Node 自身：
 *   - subGoal     本阶段的子目标（特殊的"构造函数"机制，必须存在）
 *   - skill       关联的 skill 名称。节点进入时，对应 SKILL.md 的完整内容
 *                 通过 sendUserMessage 追加到消息流中（不动 system prompt），
 *                 辅助 agent 完成本阶段任务。
 *   - tools       本阶段工具白名单
 *   - mechanisms  局部横切机制，叠加在全局机制之上
 *
 * graph 节点只声明子图调用本身。Runtime 进入子图时创建新的 AgentInstance：
 *   - globalGoal 来自子图 Graph.goal
 *   - background 来自调用点传入的 NodeInput.data
 *   - frames 从空数组开始，父图 frames 对子图不可见
 *   - 子图 END 后归约为父图 graph 节点的一次 NodeCompletion
 *     （即子图 END 边的 frame.result 成为该节点的 NodeCompletion.result）
 *
 * 子图内部节点拥有各自的 skill/tools/mechanisms；父图 graph 节点的 subGoal
 * 仅作为调用意图和外层追踪标签。
 */
export type Node =
  | {
      kind: "code";
      id: string;
      subGoal: string;
      skill?: string;
      tools?: string[];
      mechanisms?: Mechanism[];
      execute(
        instance: AgentInstance,
        input: NodeInput,
        ctx: NodeContext,
      ): Promise<NodeCompletion>;
      /** 可选：验证 __graph_complete__ 的 result。不通过则驳回让 agent 重试 */
      validateCompletion?: AgentRunRequest["validateCompletion"];
    }
  | {
      kind: "graph";
      id: string;
      subGoal: string;
      graph: Graph;
    };

// ── 机制 ──

/**
 * Mechanism 运行时上下文。onNodeEnter 通过它拿到 pi、节点、入参与实例状态，
 * 并可向 agent 消息流追加上下文。
 *
 *   pi             — 全部 pi 能力（注册原生事件、改工具集、发消息等）
 *   instance       — 当前 AgentInstance（可写 instance.scratch）
 *   node           — 当前节点
 *   input          — 代码侧一次性入参
 *   appendContext  — 向 agent 消息流追加内容（append-only，不触发 turn）。
 *
 * appendContext 是 mechanism 作用于 agent 上下文的唯一合法通道：
 *   · 追加发生在当前节点哨兵之后，属于本节点 active 段，离开节点后随
 *     ReAct 一起折叠为帧摘要——天然隔离，不泄漏到下一节点。
 *   · 遵循原则 7「追加不注入」：不改 system prompt，只在消息流侧追加。
 */
export interface MechanismContext {
  pi: ExtensionAPI;
  instance: AgentInstance;
  node: Node;
  input: NodeInput;
  appendContext(content: string): void;
}

/**
 * 横切机制。框架在节点进入后、execute 之前自动分派 onNodeEnter。
 *
 * onNodeEnter 是注册 pi 原生事件的入口——机制在里面用 ctx.pi.on() 注册
 * tool_result、turn_start、before_provider_request 等事件，这些事件在
 * agent 运行期间持续触发。pi 没有 off，回调需自限（读 ctx.instance.scratch
 * 或 ctx.node.id 判断是否仍在当前节点）。
 *
 * 全局机制（Graph.mechanisms → AgentInstance.mechanisms）跨节点持续生效；
 * 局部机制（Node.mechanisms）仅在本阶段叠加到全局之上。
 *
 * 两个合法产出通道：
 *   · ctx.instance.scratch —— 代码侧横切工作状态（见 AgentInstance.scratch）
 *   · ctx.appendContext()  —— 向 agent 消息流追加上下文（见 MechanismContext）
 * 不得写 frames/background，不得依赖闭包/模块变量传递跨节点状态。
 * onNodeEnter 抛错统一记日志后继续（不中止节点）。
 */
export interface Mechanism {
  name: string;
  onNodeEnter?(ctx: MechanismContext): Promise<void>;
}

// ── 边 ──

/**
 * 边的迁移产出。
 *
 * 边只处置栈顶层（刚刚完成的节点）：
 *   - frame   将该节点的 Completion 折叠为一帧，push 到栈顶
 *   - input   可选，作为下一节点的一次性入参
 *
 * 当边的 to 为 END：frame 仍折叠进历史，且 frame.result 同时被 Runtime
 * 取作本图的返回值（见 END 注释）；input 此时无后继节点，应省略。
 */
export interface MigrationResult {
  frame: ContextFrame; // 如何折叠栈顶层（END 边时 frame.result 兼作图的返回值）
  input?: Record<string, unknown>; // 下一节点的一次性入参，由 Runtime 包装为 NodeInput
}

/**
 * 状态迁移的承载者。
 *
 * Edge 独占三件事：
 *   1. guard   — 什么时候走这条边（只看 NodeCompletion）
 *   2. migrate — 栈顶层怎么折叠进历史，并可生成下一节点入参
 *   3. to      — 指向哪个节点（或 END 终止）
 */
export interface Edge {
  id: string;
  from: string;
  to: string | typeof END;
  priority: number;

  guard(completion: NodeCompletion): boolean;
  migrate(instance: AgentInstance, completion: NodeCompletion): MigrationResult;
}

// ── 路由 ──

export type RouterFn = (
  edges: Edge[],
  completion: NodeCompletion,
  instance: AgentInstance,
) => Edge | null | Promise<Edge | null>; // 允许异步：自定义路由可先问模型再裁决

export type RouterStrategy =
  | { kind: "priority-first" }
  | { kind: "agent-choice" }
  | { kind: "first-match" }
  | { kind: "custom"; fn: RouterFn };

export interface NodeRouting {
  nodeId: string;
  edges: Edge[];
  router: RouterStrategy;
}

// ── 调用契约 ──

/**
 * 图的对外调用契约。让同一张图同时可被：
 *   · 用户像 skill 调用   → Runtime 注册成 /name 命令
 *   · agent 像 tool 调用  → Runtime 注册成一个 LLM 工具
 *
 * 二者共享 name / description / inputSchema。
 * inputSchema 声明工具入参结构（agent 调用必需）；
 * parseArgs 将命令调用的裸文本 args 解析成 inputSchema 的形状。
 */
export interface GraphInvocation {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // 工具入参 schema，agent 调用时 LLM 依此构造
  /** 命令调用：把裸文本 args 解析成 inputSchema 的形状。默认 { args } */
  parseArgs?(args: string): Record<string, unknown>;
}


// ── 触发（调用来源归一化）──

/**
 * 一次图调用的运行时信号。三种来源，Runtime 统一归约为 background：
 *
 *   command  — 用户 /name，parseArgs(args) → background
 *   tool     — agent 工具调用，schema 校验过的 params 即 background
 *   subgraph — 上游节点（父图中 kind="graph" 的 Node）的 completion.result 即 background
 *
 * 三种来源统一后，Entry.guard 只需关注 background 中的内容，
 * 无需关心来源是用户还是 agent。
 */
export type Trigger =
  | { source: "command"; args: string }
  | { source: "tool"; params: Record<string, unknown> }
  | { source: "subgraph"; background: Record<string, unknown> };


// ── 入口 ──

/**
 * 图的入口声明。
 *
 * Runtime 将 Trigger 归一为 background 后，遍历 entries 调用 guard。
 * guard 只根据 background 的内容判断是否匹配，不关心 Trigger 的来源。
 */
export interface Entry {
  id: string;
  guard(background: Record<string, unknown>): boolean;
  startNodeId: string;
  /** 可选：构造第一个节点的 NodeInput.data。默认 background 原样传入。 */
  mapInput?(background: Record<string, unknown>): Record<string, unknown>;
}


// ── 回路图 ──

/**
 * 回路图。
 *
 * invocation?  可选。有 → 可被用户 /agent 直接调用（注册命令 + 工具）；
 *              无 → 纯内部子图，只能被别的节点引用。天然区分
 *              "库的公开 API"和"内部实现"。
 *
 * entries 声明入口；guard 只根据 background 内容判断，不关心来源。
 *
 * 子图组合：kind="graph" 的 Node 引用另一个 Graph，形成隔离栈调用。
 * 顶层图调用 = 没有调用者的子图调用。
 */
export interface Graph {
  id: string;
  goal: string; // 图的总目标；Runtime 压帧时赋给该图 AgentInstance.globalGoal
  invocation?: GraphInvocation;
  entries: Entry[];
  nodes: Record<string, Node>;
  routing: Record<string, NodeRouting>;
  /** 全局横切机制。Runtime 压帧时赋给 AgentInstance.mechanisms，跨节点持续生效。 */
  mechanisms?: Mechanism[];
}
