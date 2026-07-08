// ============================================================
//  路由器 — 单边裁决
// ============================================================

import type { Edge, NodeRouting, NodeCompletion, AgentInstance } from "./type.js";

export function selectEdge(
  routing: NodeRouting,
  completion: NodeCompletion,
  instance: AgentInstance,
): Edge | null {
  const matched = routing.edges.filter((e) => {
    try { return e.guard(completion); } catch { return false; }
  });
  if (matched.length === 0) return null;

  switch (routing.router.kind) {
    case "first-match":
      return matched[0] ?? null;
    case "priority-first":
      return [...matched].sort((a, b) => b.priority - a.priority)[0] ?? null;
    case "custom":
      return (routing.router.fn(matched, completion, instance) as Edge | null) ?? null;
    case "agent-choice":
      throw new Error("agent-choice 未实现");
    default:
      return matched[0] ?? null;
  }
}
