// ============================================================
//  节点进入消息注入
// ============================================================
//
//  每次进入节点时，构造一条 customType: "loop_graph_enter_node"
//  的消息注入 pi 对话流。
//
//  消息包含：
//    - 全局目标
//    - 当前子目标
//    - 全部历史帧栈摘要（来自 AgentInstance.frames）
//    - 当前节点一次性输入（NodeInput.data）
//    - 技能参考（如有）
//    - 完成条件说明
//
//  这条消息是"视图"——其内容从 JS 层的 AgentInstance.frames
//  渲染而来。compaction 毁掉旧消息后，下次进入节点时从 frames
//  重新渲染即可。
// ============================================================

import type { AgentInstance, ContextFrame, Node, NodeInput } from "../type.js";

export const ENTER_NODE_CUSTOM_TYPE = "loop_graph_enter_node";

/** 构造节点进入消息的文本内容 */
export function buildNodeEntryMessage(
  instance: AgentInstance,
  node: Node,
  input: NodeInput,
  skillText?: string,
): string {
  const lines: string[] = [];

  // ── 全局目标 ──
  lines.push("## 当前任务阶段");
  lines.push("");
  lines.push(`**全局目标**: ${instance.globalGoal}`);

  // ── 当前子目标 ──
  lines.push("");
  lines.push(`**当前子目标 (${node.id})**: ${node.subGoal}`);

  // ── 历史阶段摘要（全部帧栈）──
  lines.push("");
  lines.push("**已完成的阶段**:");
  if (instance.frames.length === 0) {
    lines.push("（无，这是第一个阶段）");
  } else {
    lines.push(renderFrames(instance.frames));
  }

  // ── 当前节点输入 ──
  lines.push("");
  lines.push("**当前阶段输入数据**:");
  if (Object.keys(input.data).length === 0) {
    lines.push("（无额外输入）");
  } else {
    lines.push(renderInputData(input.data));
  }

  // ── 技能参考 ──
  if (node.kind === "code" && node.skill) {
    lines.push("");
    lines.push(`**技能参考**: 已加载 skill \`${node.skill}\``);
    if (skillText) {
      lines.push("");
      lines.push("```markdown");
      lines.push(skillText);
      lines.push("```");
    }
  }

  // ── 可用工具 ──
  if (node.kind === "code" && node.tools && node.tools.length > 0) {
    lines.push("");
    lines.push(`**本阶段可用工具**: ${node.tools.join(", ")}`);
  }

  // ── 完成条件 ──
  lines.push("");
  lines.push("**完成条件**: 当你完成本阶段的所有工作后，必须调用 `__graph_complete__` 工具提交结果。");
  lines.push(`参数: status="ok"|"failed"|"cancelled", result={...}（本阶段的产出数据）`);

  return lines.join("\n");
}

/** 将帧栈渲染为文本 */
function renderFrames(frames: ContextFrame[]): string {
  return frames
    .map((f, i) => {
      const statusIcon = f.status === "ok" ? "✓" : f.status === "failed" ? "✗" : "⊘";
      const summary = f.summary || `节点 ${f.nodeId} 完成`;
      const resultPreview = summarizeResult(f.result);
      return `${i + 1}. ${statusIcon} **${f.nodeId}**: ${summary}\n   ${resultPreview}`;
    })
    .join("\n\n");
}

/** 将输入数据渲染为文本 */
function renderInputData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => {
      const valueStr = typeof v === "string" ? v : JSON.stringify(v);
      return `- **${k}**: ${valueStr}`;
    })
    .join("\n");
}

/** 将 result 渲染为一行摘要 */
function summarizeResult(result: Record<string, unknown>): string {
  const keys = Object.keys(result);
  if (keys.length === 0) return "结果: (空)";
  // 选取前 3 个 key 展示预览
  const preview = keys
    .slice(0, 3)
    .map((k) => {
      const v = result[k];
      const vs = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${vs.length > 40 ? vs.slice(0, 40) + "..." : vs}`;
    })
    .join(", ");
  const suffix = keys.length > 3 ? `, ...(共${keys.length}项)` : "";
  return `结果: ${preview}${suffix}`;
}

/** 快速判断一条消息是否是我们注入的进入消息 */
export function isNodeEntryMessage(msg: {
  customType?: string;
}): boolean {
  return msg.customType === ENTER_NODE_CUSTOM_TYPE;
}
