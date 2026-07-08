// ============================================================
//  路由器 — 单边裁决
// ============================================================

import type { Edge, NodeRouting, NodeCompletion, AgentInstance } from "./type.js";

export async function selectEdge(
  routing: NodeRouting,
  completion: NodeCompletion,
  instance: AgentInstance,
): Promise<Edge | null> {
  const matched = routing.edges.filter((e) => {
    try { return e.guard(completion); } catch { return false; }
  });
  if (matched.length === 0) return null;

  switch (routing.router.kind) {
    case "first-match":
      return matched[0] ?? null;
    case "priority-first":
      return matched
        .map((edge, index) => ({ edge, index }))
        .sort((a, b) => b.edge.priority - a.edge.priority || a.index - b.index)[0]?.edge ?? null;
    case "custom":
      return (await routing.router.fn(matched, completion, instance)) ?? null;
    case "agent-choice":
      throw new Error("agent-choice 未实现");
    default:
      return matched[0] ?? null;
  }
}
