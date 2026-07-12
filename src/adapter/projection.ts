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
  /** 活动图已经历 compaction；原生 summary 是此前上下文的权威替代。 */
  compactionActive?: boolean;
  /** node-enter 时已冻结的 SDK 合成上下文。仅在活动 scope 锚点缺失时恢复，
   *  不包含 live ReAct，也不接管 GraphCallScope/compaction 清洗。 */
  renderedContext?: readonly MessageEntry[];
}

export interface MessageEntry {
  id?: string;
  role?: string;
  content?: unknown;
  /** pi CustomMessage 的 UI 展示标记。 */
  display?: boolean;
  /** pi compactionSummary / branchSummary 使用 summary 而不是 content。 */
  summary?: string;
  timestamp?: number;
  customType?: string;
  details?: unknown;
}

export function projectMessages(input: ProjectionInput): MessageEntry[] {
  const { messages, frames, currentNode, activeScope } = input;
  const currentIdx = activeScope ? findLastMatchingScope(messages, activeScope) : -1;
  const result: MessageEntry[] = [];
  const summaryIdx = input.compactionActive ? findLastCompactionSummary(messages) : -1;

  // pi 的 summary + recent messages 是压缩后上下文的权威表达。若活动 scope
  // 仍在保留区，只保留 summary 与该 scope 后内容；若 scope 已被压缩，则在
  // summary 后恢复 CURRENT，并保留所有 recent messages。
  if (summaryIdx >= 0) result.push(messages[summaryIdx]);

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
    const recovered = input.renderedContext?.length
      ? input.renderedContext
      : [buildNodeInfo(currentNode, input.availableEdges)];
    result.push(...recovered);
    if (summaryIdx >= 0) result.push(...messages.slice(summaryIdx + 1));
  }
  return result;
}

// ── GraphCallScope 清洗（Phase 9）─────────────────────────

/**
 * 从消息数组中删除已闭合的图调用区段。
 *
 * compose / call 子图运行时在当前 session 的 transcript 中产生内部消息（NodeScope、
 * skill、mechanism、prompt 和 live ReAct）。这些消息由 loop_graph_call_start / end
 * 区段包围。子图结束后调用方不应再看到这些内部消息——它们必须从上下文中删除。
 *
 * 算法：
 *   1. 从 tail 向 head 扫描，为每个 call_end 寻找最近的前驱 call_start（按 callId 匹配）
 *   2. 已闭合区段内的全部消息标记为删除
 *   3. 未闭合的 call_start（图仍在运行中）对应的区段保留
 *
 * 此函数始终执行（无论当前是否有活动图），因为之前图调用的闭合区段需要在后续对话中持续清洗。
 */
export function stripClosedGraphCalls(messages: MessageEntry[]): MessageEntry[] {
  // 从尾部收集已闭合的区段
  const closedRanges: Array<[number, number]> = [];
  const endStack: Array<{ callId: string; endIdx: number }> = [];

  // tail → head 单次扫描：遇到 call_end 压栈，遇到匹配的 call_start 弹出并记录区段
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.customType === "loop_graph_call_end") {
      const d = m.details as Record<string, unknown> | undefined;
      if (d?.callId && typeof d.callId === "string") {
        endStack.push({ callId: d.callId, endIdx: i });
      }
    } else if (m.customType === "loop_graph_call_start") {
      const d = m.details as Record<string, unknown> | undefined;
      if (d?.callId && typeof d.callId === "string") {
        // 找最近匹配的 call_end
        for (let j = endStack.length - 1; j >= 0; j--) {
          if (endStack[j].callId === d.callId) {
            closedRanges.push([i, endStack[j].endIdx]);
            endStack.splice(j, 1);
            break;
          }
        }
      }
    }
  }

  if (closedRanges.length === 0) return messages;

  // 构建排除索引集合
  const exclude = new Set<number>();
  for (const [start, end] of closedRanges) {
    for (let i = start; i <= end; i++) exclude.add(i);
  }

  return messages.filter((_, i) => !exclude.has(i));
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
  `=== COMPLETED ===\n${JSON.stringify(frames)}\n=== END ===`;

function findLastCompactionSummary(messages: MessageEntry[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "compactionSummary") return index;
  }
  return -1;
}

type NodeInfoLike = Pick<Node, "id" | "kind" | "subGoal"> & {
  tools?: readonly string[];
  skill?: string;
};

export function buildNodeInfoContent(node: NodeInfoLike, availableEdges?: EdgeChoice[]): string {
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

export type RenderedContextContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface RenderedContextMessage {
  content: string | readonly RenderedContextContentBlock[];
  kind?: "current" | "completed" | "skill" | "instruction";
}

export interface GraphContextView {
  readonly id: string;
  readonly goal: string;
}

export interface NodeContextView {
  readonly id: string;
  readonly kind: Node["kind"];
  readonly subGoal: string;
  readonly skill?: string;
  readonly tools: readonly string[];
  readonly boundary?: import("../type.js").GraphInvocationBoundary;
  readonly childGraphId?: string;
}

export interface NodeInputView {
  readonly data: Readonly<Record<string, unknown>>;
  readonly source: Readonly<import("../type.js").NodeInput["source"]>;
}

export interface NodeContextRenderInput {
  graph: GraphContextView;
  node: NodeContextView;
  input: NodeInputView;
  /** node-enter 时 Runtime 已选择的 frame 快照。COMPLETED 主投影仍由
   * frameFormatter 管理，避免 compaction 后重复投影旧 frame。 */
  frames: readonly ContextFrame[];
  availableEdges: readonly EdgeChoice[];
  skill: { ref: string; content: string } | null;
  completion: {
    toolName: "__graph_complete__";
    statuses: readonly ["ok", "failed", "cancelled"];
  };
  reason: "node-enter";
}

export interface RenderedNodeContext {
  /** NodeScope 锚点的模型可见正文。null 表示使用空正文，但安全锚点仍存在。 */
  anchor: RenderedContextMessage | null;
  /** 锚点之后追加的其它 SDK 合成消息。 */
  additional?: readonly RenderedContextMessage[];
}

export type NodeContextRenderer =
  (input: NodeContextRenderInput) => RenderedNodeContext | null;

/** 兼容 renderer：保持当前 CURRENT 与 skill 消息的正文格式。历史 frames 继续
 * 由 frameFormatter 投影，使 compaction baseline 可以独立推进。 */
export const defaultNodeContextRenderer: NodeContextRenderer = (input) => {
  const additional: RenderedContextMessage[] = [];
  if (input.skill) {
    additional.push({
      kind: "skill",
      content: `[skill: ${input.skill.ref}]\n\n${input.skill.content}`,
    });
  }
  return {
    anchor: {
    kind: "current",
      content: buildNodeInfoContent(input.node, [...input.availableEdges]),
    },
    additional,
  };
};

function buildNodeInfo(node: Node, availableEdges?: EdgeChoice[]): MessageEntry {
  return { role: "user", content: buildNodeInfoContent(node, availableEdges), timestamp: Date.now() };
}
