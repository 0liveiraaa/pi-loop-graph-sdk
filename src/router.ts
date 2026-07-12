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
      return priorityFirst(matched);
    case "custom":
      return (await routing.router.fn(matched, completion, instance)) ?? null;
    case "agent-choice": {
      // 单边匹配 → 无需 agent 选择，直接返回
      if (matched.length === 1) return matched[0];

      // 从 completion.result 读取 agent 声明的边 ID
      const field = routing.agentChoiceField ?? "chosen_edge_id";
      const chosenId = completion.result?.[field];

      if (typeof chosenId === "string") {
        const edge = matched.find((e) => e.id === chosenId);
        if (edge) return edge;
      }

      // 防御性降级：正常情况下 upstream validateCompletion 已拦截并让 agent 重试，
      // 此处 priority-first 作为兜底不应该被执行到。
      return priorityFirst(matched);
    }
    default:
      return matched[0] ?? null;
  }
}

function priorityFirst(matched: Edge[]): Edge | null {
  return matched
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => b.edge.priority - a.edge.priority || a.index - b.index)[0]
    ?.edge ?? null;
}
