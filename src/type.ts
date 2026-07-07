// ============================================================
//  Loop Graph SDK — 核心类型定义
// ============================================================
//
//  栈式子图编排
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
 *   frames      — 有序执行历史，只增不减
 *   mechanisms  — 全局横切机制，跨节点持续生效
 *
 * 阶段性工作状态不挂在 AgentInstance 上。节点只能从 background 和 frames
 * 读取已经显式进入历史的上下文。
 */
export interface AgentInstance {
  id: string;
  globalGoal: string;
  background: Record<string, unknown>;
  frames: ContextFrame[];
  mechanisms: Mechanism[];
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
  runAgent(request: AgentRunRequest): Promise<AgentRunResult>;
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface AgentRunRequest {
  prompt: string;
  tools?: string[];
  skill?: string;
  outputSchema?: unknown;
}

export interface AgentRunResult {
  text: string;
  result?: Record<string, unknown>;
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
 *   - skill       关联的 skill 路径（落地为将 skill 文本注入系统提示）
 *   - tools       本阶段工具白名单
 *   - mechanisms  局部横切机制，叠加在全局机制之上
 *
 * graph 节点只声明子图调用本身。Runtime 进入子图时创建新的 AgentInstance：
 *   - background 来自调用点传入的 NodeInput.data
 *   - frames 从空数组开始，父图 frames 对子图不可见
 *   - 子图 END 后归约为父图 graph 节点的一次 NodeCompletion
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
    }
  | {
      kind: "graph";
      id: string;
      subGoal: string;
      graph: Graph;
    };

// ── 机制 ──

/**
 * 横切面基础设施。
 * 全局机制（AgentInstance.mechanisms）跨节点持续生效；
 * 局部机制（Node.mechanisms）仅在本阶段叠加到全局上。
 */
export interface Mechanism {
  name: string;
  check(instance: AgentInstance): boolean;
  apply(instance: AgentInstance): Promise<void>;
}

// ── 边 ──

/**
 * 边的迁移产出。
 *
 * 边只处置栈顶层（刚刚完成的节点）：
 *   - frame   将该节点的 Completion 折叠为一帧，push 到栈顶
 *   - input   可选，作为下一节点的一次性入参
 */
export interface MigrationResult {
  frame: ContextFrame; // 如何折叠栈顶层
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
) => Edge | null;

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

// ── 触发与图 ──

export interface Trigger {
  command: string;
  args: string;
}

export interface Entry {
  id: string;
  guard(trigger: Trigger, background: Record<string, unknown>): boolean;
  startNodeId: string;
  input?: (
    trigger: Trigger,
    background: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * 回路图。
 *
 * 入口由 entries 声明。Entry.guard 判断 trigger/background 是否匹配；
 * startNodeId 指向第一个实际节点；input 可为第一个节点构造一次性入参。
 *
 * 子图组合：复合 Node 引用另一个 Graph（Node.graph），形成隔离栈调用。
 * 顶层图调用 = 没有调用者的子图调用。
 */
export interface Graph {
  id: string;
  entries: Entry[];
  nodes: Record<string, Node>;
  routing: Record<string, NodeRouting>;
}
