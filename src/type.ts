// ============================================================
//  Loop Graph SDK — 核心类型定义
// ============================================================

// ── 终止标记 ──

/** 唯一终止标记。Edge.to 设为 END 表示"合法终止"。 */
export const END = Symbol("graph.end");

// ── 节点完成信号 ──

/** 节点执行完毕后产出的结构化信号。Edge.guard 的唯一判断依据。 */
export interface NodeCompletion {
  nodeId: string;
  status: string;                      // "ok" | "failed" | "cancelled"
  result: Record<string, unknown>;
  agentHint?: string;
}

// ── 上下文 ──

/**
 * 已完成节点的折叠快照。
 * 节点执行完毕后，中间过程丢弃，只保留此摘要。
 */
export interface CompletedNodeSnapshot {
  status: string;                      // "ok" | "failed" | "cancelled"
  summary: string;                     // 折叠后的一句话摘要
  result: Record<string, unknown>;
}

// ── Agent 实例 ──

/**
 * 回路图中的活动主体。
 *
 * context 约定：
 *   以 nodeId 为 key。顶层字段为初始上下文；已完成节点为 CompletedNodeSnapshot；
 *   当前节点在 execute 内部管理，折叠后写入。
 */
export interface AgentInstance {
  id: string;
  globalGoal: string;
  context: Record<string, unknown>;
}

// ── 节点 ──

/**
 * 可运行工作阶段。节点自身声明一切所需：
 *   - subGoal / skill → 引导 agent 行为
 *   - tools            → 本阶段工具白名单
 *   - execute          → 代码或 agent 逻辑
 *
 * Runtime 进入节点时直接从 Node 读取配置，不经过 Edge 中转。
 */
export interface Node {
  id: string;
  subGoal: string;
  skill?: string;
  tools?: string[];                    // 本节点可用的工具 id 列表
  execute(instance: AgentInstance): Promise<NodeCompletion>;
}

// ── 边 ──

/**
 * 状态迁移的声明式载体。
 *
 * guard 是函数（需要检查 NodeCompletion）；migrate 是数据声明。
 * 不设 PrepareEntryResult —— 目标节点所需的工具和技能已声明在 Node 自身。
 */
export interface Edge {
  id: string;
  from: string;
  to: string | typeof END;
  priority: number;

  /** 检查迁移条件。 */
  guard(completion: NodeCompletion): boolean;

  /** 上下文迁移规则*/
  migrate: {
    keep: string[];                    
    discard: string[];                 
    inject: Record<string, unknown>;   // 新注入的上下文字段
  };
}

// ── 路由 ──

/** 路由策略。 */
export type RouterStrategy =
  | { kind: "priority-first" }
  | { kind: "agent-choice" }
  | { kind: "first-match" }
  | { kind: "all-satisfied" };

/** 节点的出口路由配置。 */
export interface NodeRouting {
  nodeId: string;
  edges: Edge[];
  router: RouterStrategy;
}

// ── 触发与图 ──

/** 图的调用触发条件。 */
export interface Trigger {
  command: string;
  args: string;
}

/**
 * 回路图。
 *
 * 入口采用虚拟 START 节点：
 *   routing["START"] 中的 Edge 充当入口边，startNodeId 指向第一个实际节点。
 *   不设独立的 Entry 结构。
 */
export interface Graph {
  id: string;
  trigger: Trigger;
  startNodeId: string;
  nodes: Record<string, Node>;
  routing: Record<string, NodeRouting>;   // 含 "START"
  fallbackGraph?: Graph;
}
