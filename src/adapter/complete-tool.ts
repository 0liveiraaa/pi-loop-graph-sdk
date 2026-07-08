// ============================================================
//  __graph_complete__ 工具定义
// ============================================================
//
//  这是 Loop Graph Runtime 的内部终止工具。
//  agent 在每个节点完成工作时必须调用此工具，参数直接成为
//  NodeCompletion。
//
//  工具在节点开始时注册，节点结束时注销，对非图运行的
//  普通对话不可见。
// ============================================================

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const COMPLETE_TOOL_NAME = "__graph_complete__";

/** __graph_complete__ 的参数结构 */
export const CompleteToolSchema = Type.Object({
  status: Type.String({
    enum: ["ok", "failed", "cancelled"],
    description:
      "本阶段完成状态：ok=成功完成，failed=无法完成，cancelled=用户取消",
  }),
  result: Type.Record(Type.String(), Type.Unknown(), {
    description: "本阶段的产出数据，键值对形式",
  }),
  reason: Type.Optional(
    Type.String({
      description:
        "如果 status 为 failed 或 cancelled，说明原因。用于让 Runtime 决定后续路由",
    }),
  ),
});

export type CompleteToolParams = {
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
  reason?: string;
};

/** 创建 __graph_complete__ 工具定义 */
export function createCompleteTool(): ToolDefinition {
  return {
    name: COMPLETE_TOOL_NAME,
    label: "完成阶段",
    description:
      "完成当前 Loop Graph 节点的所有工作后必须调用此工具。将本阶段的产出结果上报给图运行时，以便进入下一个节点或结束运行。",
    promptSnippet:
      "完成当前阶段工作后调用，上报 status 和 result",
    promptGuidelines: [
      `当本节点所有工作（生成、批改、讨论等）完成后，必须调用 ${COMPLETE_TOOL_NAME} 工具提交结果。`,
      `status 设为 "ok" 表示成功完成，"failed" 表示因故无法完成，"cancelled" 表示用户主动取消。`,
      `result 中应包含本阶段的完整产出数据，供后续节点或最终输出使用。`,
    ],
    parameters: CompleteToolSchema,
    async execute(_toolCallId, params: any) {
      // 这个 execute 实际上不会被调用（由 PiNodeContext 拦截 tool_result 事件获取参数）
      // 但如果被调用，透传参数
      const p = params as CompleteToolParams;
      return {
        content: [
          {
            type: "text",
            text: `节点完成: status=${p.status}`,
          },
        ],
        details: p as unknown as Record<string, unknown>,
      };
    },
  };
}
