// ============================================================
//  完成度验证测试图
// ============================================================
//
//  /validate-test → require_minimum → END
//
//  require_minimum 节点声明 validateCompletion：
//    - 要求 result 必须含 question 和 answer 两个字段
//    - 第一次 agent 可能只报一个字段 → 驳回 → agent 补全
//    - 第二次上报完整 → 通过
//
//  验证：
//    1. 驳回后 agent 收到重试消息
//    2. 补全后正常结束
// ============================================================

import type { Edge, Entry, Graph, Node } from "../type.js";
import { END } from "../type.js";
import { createAgentExecute } from "../agent-execute.js";

function requireMinValidator(
  result: Record<string, unknown>,
): { isValid: true } | { isValid: false; reason: string } {
  if (!result.question || typeof result.question !== "string") {
    return { isValid: false, reason: "缺少 question 字段（应为字符串类型的题目文本）" };
  }
  if (!result.answer || typeof result.answer !== "string") {
    return { isValid: false, reason: "缺少 answer 字段（应为字符串类型的答案文本）" };
  }
  return { isValid: true };
}

const requireMinNode: Node = {
  kind: "code",
  id: "require_min",
  subGoal: "生成一道题目和答案，格式必须包含 question 和 answer",
  execute: createAgentExecute({ prompt: "生成一道题目和答案，格式必须包含 question 和 answer", validateCompletion: requireMinValidator }),
};

const validateEntry: Entry = {
  id: "val_entry",
  guard: () => true,
  startNodeId: "require_min",
};

const validateEdge: Edge = {
  id: "val_to_end",
  from: "require_min",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `验证节点完成: question=${completion.result.question}, answer=${completion.result.answer}`,
        result: completion.result,
      },
    };
  },
};

export const validateGraph: Graph = {
  id: "validate_test",
  goal: "验证完成度检查机制",
  invocation: {
    name: "validate-test",
    description: "完成度验证测试",
    inputSchema: { type: "object", properties: {} },
  },
  entries: [validateEntry],
  nodes: { require_min: requireMinNode },
  routing: {
    require_min: {
      nodeId: "require_min",
      edges: [validateEdge],
      router: { kind: "first-match" },
    },
  },
};

