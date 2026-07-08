// ============================================================
//  投影 — context 钩子的消息组装逻辑
// ============================================================
//
//  每次 LLM 调用时，pi 触发 context 事件，传入 messages 数组。
//  投影函数将其重组为三段：
//    1. head  — nodeStartEntryId 之前的消息（系统提示等原始 head）
//    2. frame — 帧栈摘要（从 instance.frames 渲染）
//    3. active — nodeStartEntryId 之后的消息（当前节点 live ReAct）
//
//  投影是纯函数，可脱离 pi 单测。
// ============================================================

import type { ContextFrame, Node, NodeInput } from "../type.js";

export interface ProjectionInput {
  /** pi 传来的全部消息 */
  messages: MessageEntry[];
  /** 栈顶 instance.frames */
  frames: ContextFrame[];
  /** 当前节点（null = 不在活跃节点中） */
  currentNode: Node | null;
  /** 当前节点输入 */
  currentInput: NodeInput | null;
  /** 活跃段起点（leafId） */
  nodeStartEntryId: string | null;
}

/** 投影需要的消息最小接口 */
export interface MessageEntry {
  id?: string;
  role?: string;
  content?: unknown;
  timestamp?: number;
  customType?: string;
}

/**
 * 重组 messages 为 [head, frame段, active段]。
 *
 * - head：nodeStartEntryId 之前的所有消息（不动）
 * - frame段：两条合成消息，内容为帧栈摘要 + 当前节点信息
 *   如果不在活跃节点中，只有帧栈摘要
 * - active：nodeStartEntryId 及之后的消息（当前节点 live ReAct）
 */
export function projectMessages(input: ProjectionInput): MessageEntry[] {
  const { messages, frames, currentNode, currentInput, nodeStartEntryId } = input;

  // 1. 找到切分点
  const splitIdx = nodeStartEntryId
    ? messages.findIndex((m) => m.id === nodeStartEntryId)
    : -1;

  const head = splitIdx >= 0 ? messages.slice(0, splitIdx) : messages;
  const active = splitIdx >= 0 ? messages.slice(splitIdx) : [];

  // 2. 构造帧栈摘要消息
  const frameMsg = buildFrameMessage(frames);

  // 3. 构造当前节点信息消息（如果正在活跃节点中）
  const nodeInfoMsg = currentNode
    ? buildNodeInfoMessage(currentNode, currentInput)
    : null;

  // 4. 组装
  const result: MessageEntry[] = [...head];

  if (frameMsg) result.push(frameMsg);

  // 如果 frame 为空且不在活跃节点中，不插入节点信息
  if (nodeInfoMsg && currentNode) {
    result.push(nodeInfoMsg);
  }

  result.push(...active);

  return result;
}

// ── 内部渲染 ──────────────────────────────────────────────

function buildFrameMessage(frames: ContextFrame[]): MessageEntry | null {
  if (frames.length === 0) return null;

  const items = frames.map((f, i) => ({
    nodeId: f.nodeId,
    status: f.status,
    summary: f.summary || `节点 ${f.nodeId} 完成`,
    result: f.result,
  }));

  return {
    role: "user",
    content: 
      "=== COMPLETED ===\n" +
      JSON.stringify(items) +
      "\n=== END ===",
  };
}

function buildNodeInfoMessage(
  node: Node,
  input: NodeInput | null,
): MessageEntry {
  const lines: string[] = ["=== CURRENT ==="];

  lines.push(`nodeId: ${node.id}`);
  lines.push(`subGoal: ${node.subGoal}`);

  if (input && Object.keys(input.data).length > 0) {
    lines.push("input:");
    for (const [k, v] of Object.entries(input.data)) {
      lines.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }

  if (node.kind === "code") {
    if (node.tools && node.tools.length > 0) {
      lines.push(`tools: ${node.tools.join(", ")}`);
    }
    if (node.skill) {
      lines.push(`skill: ${node.skill}`);
    }
  }

  lines.push("completeWith: __graph_complete__({ status, result })");
  lines.push("=== END ===");

  return {
    role: "user",
    content: lines.join("\n"),
  };
}
