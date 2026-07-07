// ============================================================
//  Loop Graph SDK — 核心类型定义
// ============================================================

// ── 终止标记 ──

/** 唯一终止标记。Edge.to 设为 END 表示"合法终止"。 */
export const END = Symbol("graph.end");

// ── 节点完成信号 ──

/**
 * 节点执行完毕的结构化产出。
 * 这是 Node 对外的唯一输出 —— 不做折叠，不写 summary。
 * 如何"记住"这段经历，由 Edge.migrate 决定。
 */
export interface NodeCompletion {
  nodeId: string;
  status: string;                      // "ok" | "failed" | "cancelled"
  result: Record<string, unknown>;
  agentHint?: string;
}

// ── 上下文 ──

/**
 * 已完成节点的折叠快照。
 * 由 Edge.migrate 生成并写入 context[nodeId]。
 * 不同边可以对同一个 completion 产出不同的快照 ——
 * 取决于"进入下一阶段时需要记住什么"。
 */
export interface CompletedNodeSnapshot {
  status: string;
  summary: string;
  result: Record<string, unknown>;
}

// ── Agent 实例 ──

/**
 * 回路图中的活动主体。
 *
 * context 约定：
 *   顶层字段为进入工作流前的初始上下文；
 *   以 nodeId 为 key 的值为 CompletedNodeSnapshot（已完成节点）；
 *   当前节点在 execute 内部管理，不写入 context。
 */
export interface AgentInstance {
  id: string;
  globalGoal: string;
  context: Record<string, unknown>;
  mechanisms: Mechanism[];             // 全局横切机制，跨节点持续生效
}

// ── 节点 ──

/**
 * 可运行工作阶段。
 *
 * 节点只负责完成子目标并产出 NodeCompletion。
 * 不折叠上下文、不写 summary、不知道接下来去哪。
 * 配置（tools / subGoal / skill）声明在 Node 自身，Runtime 直接读取。
 */
export interface Node {
  id: string;
  subGoal: string;                     // 特殊机制 — 本节点的身份本身，必须存在
  skill?: string;
  tools?: string[];
  mechanisms?: Mechanism[];            // 局部机制 — 可选，仅在本阶段生效
  execute(instance: AgentInstance): Promise<NodeCompletion>;
}

// ── 机制 ──

/**
 * 横切面基础设施。
 *
 * 全局机制（AgentInstance.mechanisms）跨节点持续生效；
 * 局部机制（Node.mechanisms）仅在本阶段叠加到全局上。
 *
 * subGoal 是特殊的"构造函数"机制 —— 它定义了节点的身份本身，
 * 因此在 Node 上以顶层字段存在，而非放在 mechanisms 数组里。
 */
export interface Mechanism {
  name: string;
  /** 检查触发条件是否满足 */
  check(context: Record<string, unknown>): boolean;
  /** 执行机制动作 */
  apply(instance: AgentInstance): Promise<void>;
}

// ── 边 ──

/**
 * 边的迁移产出。
 * 不同边对同一个 NodeCompletion 可以产出不同的 migrate 策略 ——
 * 因为每条边代表了"以什么姿态进入下一阶段"的不同意图。
 */
export interface MigrationResult {
  keep: string[];                      // 保留哪些 nodeId 对应的上下文
  discard: string[];                   // 丢弃哪些
  inject: Record<string, unknown>;     // 注入新字段
  snapshot: CompletedNodeSnapshot;     // 如何折叠并记住刚完成的节点
}

/**
 * 状态迁移承载者。
 *
 * Edge 独占三件事：
 *   1. guard  —— 什么时候走这条边
 *   2. migrate —— 怎么清算当前节点、怎么进入下一阶段（函数，可依据 completion 动态决策）
 *   3. 目标指向 —— to 字段
 *
 * 进入目标节点所需的 tools / skill / subGoal 由目标 Node 自行声明，
 * Edge 不负责 prepareEntry。
 */
export interface Edge {
  id: string;
  from: string;
  to: string | typeof END;
  priority: number;

  /** 检查迁移条件是否满足。只依赖 NodeCompletion。 */
  guard(completion: NodeCompletion): boolean;

  /** 清算当前节点 + 准备上下文的迁移规则。 */
  migrate(instance: AgentInstance, completion: NodeCompletion): MigrationResult;
}

// ── 路由 ──

export type RouterStrategy =
  | { kind: "priority-first" }
  | { kind: "agent-choice" }
  | { kind: "first-match" }
  | { kind: "all-satisfied" };

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
 * 入口采用虚拟 START 节点：
 *   routing["START"] 中的 Edge 充当入口边，
 *   startNodeId 指向第一个实际节点。
 */
export interface Graph {
  id: string;
  trigger: Trigger;
  startNodeId: string;
  nodes: Record<string, Node>;
  routing: Record<string, NodeRouting>;
  fallbackGraph?: Graph;
}
