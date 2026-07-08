// ============================================================
//  execute 工厂 — 声明式 agent 节点的一行定义
// ============================================================

import type { AgentInstance, AgentRunRequest, Node, NodeCompletion, NodeContext, NodeInput } from "./type.js";

export interface AgentExecuteOptions {
  prompt?: string | ((input: NodeInput) => string);
  skill?: string;
  tools?: string[];
  validateCompletion?: AgentRunRequest["validateCompletion"];
}

type CodeNode = Extract<Node, { kind: "code" }>;

/**
 * 创建一个 agent 节点的 execute 函数。
 *
 * 用法：
 * ```
 * execute: createAgentExecute({ skill: "review-grade", tools: ["review_answer"] })
 * ```
 */
export function createAgentExecute(
  options: AgentExecuteOptions = {},
): CodeNode["execute"] {
  return async (
    _instance: AgentInstance,
    input: NodeInput,
    ctx: NodeContext,
  ): Promise<NodeCompletion> => {
    const prompt =
      typeof options.prompt === "function"
        ? options.prompt(input)
        : options.prompt ?? "开始执行当前阶段";
    return ctx.runAgent({
      prompt,
      tools: options.tools,
      skill: options.skill,
      validateCompletion: options.validateCompletion,
    });
  };
}
