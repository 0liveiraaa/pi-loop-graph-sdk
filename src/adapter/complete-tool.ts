// ============================================================
//  __graph_complete__ 工具定义
// ============================================================

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const COMPLETE_TOOL_NAME = "__graph_complete__";

export function createCompleteTool(): ToolDefinition {
  return {
    name: COMPLETE_TOOL_NAME,
    label: "完成阶段",
    description:
      "完成当前 Loop Graph 节点后调用，上报 status 和 result。",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["ok", "failed", "cancelled"],
          description: "ok=成功, failed=失败, cancelled=取消",
        },
        result: {
          type: "object",
          description: "本阶段产出数据",
        },
      },
      required: ["status", "result"],
    } as any,
    async execute(_toolCallId: any, params: any) {
      return {
        content: [
          { type: "text", text: `节点完成: ${params.status}` },
        ],
        details: params,
      };
    },
  };
}
