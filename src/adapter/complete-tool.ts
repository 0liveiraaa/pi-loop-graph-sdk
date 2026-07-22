// ============================================================
//  __graph_complete__ 工具定义
// ============================================================

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CompletionSubmissionDecision } from "../type.js";

export const COMPLETE_TOOL_NAME = "__graph_complete__";

export function createCompleteTool(): ToolDefinition {
  return {
    name: COMPLETE_TOOL_NAME,
    label: "完成阶段",
    description:
      "提交当前 Loop Graph 节点的候选结果。只有 Runtime 检查通过后节点才算完成。",
    parameters: {
      type: "object",
      properties: {
        result: {
          type: "object",
          description: "本阶段产出数据",
        },
      },
      required: ["result"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId: any, _params: any) {
      return {
        content: [
          { type: "text", text: "节点结果已提交，等待检查。" },
        ],
        // 原始参数已经存在于 assistant tool call 和 ToolResultEvent.input。
        // 不在 tool result details 中复制，避免其他扩展或 UI 将其误作 Runtime 结论。
        details: undefined,
      };
    },
    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("提交节点结果")), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const decision = result.details as CompletionSubmissionDecision | undefined;
      let content: string;
      if (!decision) {
        content = theme.fg("muted", "节点结果已提交，等待检查");
      } else if (decision.decision === "accepted") {
        content = theme.fg("success", "✓ 节点结果已通过检查");
      } else if (decision.decision === "rejected") {
        content = theme.fg("error", `✗ 节点结果未被接受：${decision.reason}`);
      } else {
        content = theme.fg("error", `✗ ${decision.scope === "graph" ? "图" : "节点"}验收失败：${decision.reason}`);
      }
      return new Text(content, 0, 0);
    },
  };
}
