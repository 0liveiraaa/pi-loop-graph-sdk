// ============================================================
//  帧栈持久化 / 恢复
// ============================================================
//
//  利用 pi.appendEntry() 在 agent_end 后将 AgentInstance 的
//  帧栈持久化到 session。session_start 时恢复。
//
//  持久化的数据：id, globalGoal, background, frames
//  不持久化：mechanisms（函数不可序列化，MVP 不使用）
//
//  关键保证：帧栈在 JS 层是 canonical，messages 中的注入消息
//  只是"视图"。compaction 毁掉消息后，帧栈仍然存活。
// ============================================================

import type { AgentInstance, ContextFrame } from "../type.js";

export const STATE_ENTRY_TYPE = "loop_graph_instance";

export interface PersistedInstance {
  id: string;
  globalGoal: string;
  background: Record<string, unknown>;
  frames: ContextFrame[];
  /** 当前活跃运行的图 ID（用于 session 恢复时判断是否有未完成的图） */
  activeGraphId: string | null;
  /** 当前节点 ID（用于 session 恢复时继续执行） */
  currentNodeId: string | null;
  /** 当前节点输入（用于 session 恢复时继续执行） */
  currentNodeInput: Record<string, unknown> | null;
}

/** 从 AgentInstance 提取可序列化数据 */
export function serializeInstance(
  instance: AgentInstance,
  extra?: {
    activeGraphId?: string;
    currentNodeId?: string;
    currentNodeInput?: Record<string, unknown>;
  },
): PersistedInstance {
  return {
    id: instance.id,
    globalGoal: instance.globalGoal,
    background: instance.background,
    frames: instance.frames,
    activeGraphId: extra?.activeGraphId ?? null,
    currentNodeId: extra?.currentNodeId ?? null,
    currentNodeInput: extra?.currentNodeInput ?? null,
  };
}

/** 从持久化数据恢复 AgentInstance */
export function deserializeInstance(data: PersistedInstance): AgentInstance {
  return {
    id: data.id,
    globalGoal: data.globalGoal,
    background: data.background,
    frames: data.frames,
    mechanisms: [],
  };
}

/** 检查持久化数据是否表示有未完成的图运行（用于 session 恢复判断） */
export function hasActiveRun(data: PersistedInstance): boolean {
  return data.activeGraphId !== null && data.currentNodeId !== null;
}
