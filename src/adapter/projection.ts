// ============================================================
//  投影 — context 钩子的消息组装（纯函数）
// ============================================================

import type { ContextFrame, Node } from "../type.js";
import type { NodeScopeDescriptor } from "../runtime.js";

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
  activeScope?: NodeScopeDescriptor | null;
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
  details?: unknown;
}

export function projectMessages(input: ProjectionInput): MessageEntry[] {
  const { messages, frames, currentNode, activeScope } = input;
  const currentIdx = activeScope ? findLastMatchingScope(messages, activeScope) : -1;
  const result: MessageEntry[] = [];

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

  if (currentIdx >= 0) {
    const includeAnchor = messages[currentIdx]?.customType === "loop_graph_node_scope";
    result.push(...messages.slice(currentIdx + (includeAnchor ? 0 : 1)));
  } else if (currentNode) {
    // fail closed：scope 丢失时只恢复确定性节点信息，绝不回退 raw transcript。
    result.push(buildNodeInfo(currentNode, input.availableEdges));
  }
  return result;
}

function findLastMatchingScope(
  messages: MessageEntry[],
  activeScope: NodeScopeDescriptor,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isMatchingScope(messages[index], activeScope)) return index;
  }
  return -1;
}

function isMatchingScope(
  message: MessageEntry,
  activeScope: NodeScopeDescriptor,
): boolean {
  if (message.customType !== "loop_graph_node_scope") return false;
  const details = message.details as Partial<NodeScopeDescriptor> | undefined;
  return details?.protocol === 2 && details.scopeId === activeScope.scopeId;
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

export function buildNodeInfoContent(node: Node, availableEdges?: EdgeChoice[]): string {
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

  return lines.join("\n");
}

function buildNodeInfo(node: Node, availableEdges?: EdgeChoice[]): MessageEntry {
  return { role: "user", content: buildNodeInfoContent(node, availableEdges), timestamp: Date.now() };
}
