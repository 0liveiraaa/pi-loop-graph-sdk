// ============================================================
//  投影 — context 钩子的消息组装（纯函数）
// ============================================================

import type { ContextFrame, Node } from "../type.js";

export interface EdgeChoice {
  id: string;
  description: string;
  priority: number;
  target: string;
}

export interface ProjectionInput {
  messages: MessageEntry[];
  frames: ContextFrame[];
  currentNode: Node | null;
  /** 哨兵标记：customType="loop_graph_boundary" 的 content */
  nodeMarker: string | null;
  /** agent-choice 路由下可供 agent 选择的边列表，渲染在 CURRENT 段 */
  availableEdges?: EdgeChoice[];
  /** 自定义帧折叠后的 COMPLETED 段内容格式。
   *  接收所有已完成帧，返回完整文本注入上下文。
   *  返回 null 则跳过 COMPLETED 段（不折叠）。
   *  默认：保持当前 JSON 格式（向后兼容）。 */
  frameFormatter?: (frames: ContextFrame[]) => string | null;
}

export interface MessageEntry {
  id?: string;
  role?: string;
  content?: unknown;
  timestamp?: number;
  customType?: string;
}

export function projectMessages(input: ProjectionInput): MessageEntry[] {
  const { messages, frames, currentNode, nodeMarker } = input;

  const isBoundary = (m: MessageEntry) =>
    m.customType === "loop_graph_boundary";

  // 当前节点哨兵：本节点 live ReAct 的起点
  const currentIdx = nodeMarker
    ? messages.findIndex((m) => isBoundary(m) && m.content === nodeMarker)
    : -1;

  // 首个哨兵：任何节点开始之前的分界。它之前的是真正的 head
  // （系统提示 + 原始 invocation），之后到当前哨兵之间全是已完成
  // 节点的 ReAct —— 这段整体丢弃，由帧摘要顶替。
  const firstIdx = messages.findIndex(isBoundary);

  // head：截到任何节点开始之前
  //   currentIdx < 0（未匹配到当前哨兵）时退化为「全部留作 head」，
  //   把摘要/节点信息追加到末尾，绝不把它们插到系统提示之前。
  // active：当前哨兵之后（哨兵本身 skip，+1）
  const head =
    currentIdx >= 0
      ? messages.slice(0, firstIdx >= 0 ? firstIdx : currentIdx)
      : messages;
  const active = currentIdx >= 0 ? messages.slice(currentIdx + 1) : [];

  const result: MessageEntry[] = [...head];

  // frame 段
  if (frames.length > 0) {
    const fmt = input.frameFormatter ?? defaultFrameFormatter;
    const content = fmt(frames);
    if (content != null) {
      result.push({
        role: "user",
        content,
        timestamp: Date.now(),
      });
    }
  }

  // 当前节点段
  if (currentNode) {
    result.push(buildNodeInfo(currentNode, input.availableEdges));
  }

  result.push(...active);
  return result;
}

/** 默认帧格式化器：保持向后兼容的 JSON 格式（=== COMPLETED === / === END === 包裹）。 */
export const defaultFrameFormatter = (frames: ContextFrame[]) =>
  `=== COMPLETED ===\n${JSON.stringify(
    frames.map((f) => ({
      nodeId: f.nodeId,
      status: f.status,
      summary: f.summary,
      result: f.result,
    })),
  )}\n=== END ===`;

function buildNodeInfo(node: Node, availableEdges?: EdgeChoice[]): MessageEntry {
  const lines: string[] = ["=== CURRENT ==="];
  lines.push(`nodeId: ${node.id}`);
  lines.push(`subGoal: ${node.subGoal}`);

  if (node.kind === "code") {
    if (node.tools?.length) lines.push(`tools: ${node.tools.join(", ")}`);
    if (node.skill) lines.push(`skill: ${node.skill}`);
  }

  // agent-choice 路由：渲染可用边列表供 agent 决策
  if (availableEdges && availableEdges.length > 0) {
    lines.push("");
    lines.push("availableEdges（请在 __graph_complete__ 的 result.chosen_edge_id 中选择一条）:");
    for (const e of availableEdges) {
      const targetLabel = e.target === "Symbol(graph.end)" ? "END" : (e.target || "?");
      lines.push(`  • ${e.id} (priority: ${e.priority}) → ${targetLabel}`);
      lines.push(`    ${e.description}`);
    }
  }

  lines.push("completeWith: __graph_complete__({ status, result })");
  lines.push("=== END ===");

  return { role: "user", content: lines.join("\n"), timestamp: Date.now() };
}
