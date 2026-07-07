// ============================================================
//  Loop Graph SDK — 核心类型定义
// ============================================================
//
//  世界模型：栈式子图编排
//
//    AgentInstance 持有一个有序帧栈（frames），每进入一个节点就在栈上生长一层，
//    离开节点时边负责折叠栈顶层。栈只增不减，历史不可篡改。
//
//    子图调用是一等公民：Node 可以引用另一个 Graph 作为其实现。
//    子图执行期间帧继续生长；子图结束时整段帧归约为该 Node 的一次产出。
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
  agentHint?: string;
}


// ── 栈帧 ──

/**
 * 栈中的一层。每进入一个节点就 push 一帧；
 * 离开节点时由 Edge.migrate 填写 snapshot 将其折叠。
 */
export interface ContextFrame {
  nodeId: string;
  graphId: string;                       // 该帧属于哪个图（子图嵌套时区分）
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
 */
export interface AgentInstance {
  id: string;
  globalGoal: string;
  background: Record<string, unknown>;
  frames: ContextFrame[];
  mechanisms: Mechanism[];
}


// ── 节点 ──

/**
 * 可运行工作阶段。
 *
 * 配置声明在 Node 自身：
 *   - subGoal     本阶段的子目标（一种特殊的"构造函数"机制，必须存在）
 *   - skill       关联的 skill 路径（落地为将 skill 文本注入系统提示）
 *   - tools       本阶段工具白名单
 *   - mechanisms  局部横切机制，叠加在全局机制之上
 *   - graph       若存在则本节点是一个子图调用，execute 委托给该子图
 */
export interface Node {
  id: string;
  subGoal: string;
  skill?: string;
  tools?: string[];
  mechanisms?: Mechanism[];
  graph?: Graph;                         // 子图调用：本节点的实现
  execute(instance: AgentInstance): Promise<NodeCompletion>;
}


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
 *   - inject  携带给下一节点的上下文（不进入栈，是节点间的临时传递）
 */
export interface MigrationResult {
  frame: ContextFrame;                   // 如何折叠栈顶层
  inject: Record<string, unknown>;       // 节点间的临时传递
}

/**
 * 状态迁移的承载者。
 *
 * Edge 独占三件事：
 *   1. guard   — 什么时候走这条边（只看 NodeCompletion）
 *   2. migrate — 栈顶层怎么折叠、下一节点带什么上下文
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
) => Edge | Edge[] | null;

export type RouterStrategy =
  | { kind: "priority-first" }
  | { kind: "agent-choice" }
  | { kind: "first-match" }
  | { kind: "all-satisfied" }
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

/**
 * 回路图。
 *
 * 入口采用虚拟 START 节点：routing["START"] 中的 Edge 充当入口边，
 * startNodeId 指向第一个实际节点。
 *
 * 子图组合：Node.graph 可引用另一个 Graph，形成嵌套调用。
 * 顶层图调用 = 没有调用者的子图调用。
 */
export interface Graph {
  id: string;
  trigger: Trigger;
  startNodeId: string;
  nodes: Record<string, Node>;
  routing: Record<string, NodeRouting>;
}
