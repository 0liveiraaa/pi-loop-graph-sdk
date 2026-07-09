// ============================================================
//  双节点链式测试图
// ============================================================
//  验证：agent_end → resolve → 推进下一节点 → 再起 turn
//
//  节点 1 (echo_a)：agent 复述输入，__graph_complete__ 上报
//  节点 2 (echo_b)：agent 收到节点 1 的 result，二次复述
//
//  预期：
//    节点 2 的投影里 COMPLETED 含节点 1 的 summary
//    CURRENT 是节点 2 的子目标 + input
//    节点 1 的 ReAct（"让我复述..."）不出现在节点 2 的上下文
// ============================================================

import type { Edge, Entry, Graph, Node, NodeCompletion, NodeRouting } from "../type.js";
import { END } from "../type.js";
import { createAgentExecute } from "../agent-execute.js";

const nodeA: Node = {
  kind: "code",
  id: "echo_a",
  subGoal: "接收用户输入，复述一遍，然后调用 __graph_complete__ 上报",
  execute: createAgentExecute({
    prompt: (input) =>
      `用户输入: ${JSON.stringify(input.data)}\n请复述一遍，然后调用 __graph_complete__ 上报`,
  }),
};

const edgeA: Edge = {
  id: "a_to_b",
  from: "echo_a",
  to: "echo_b",
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `节点 A 完成，输出: ${JSON.stringify(completion.result).slice(0, 80)}`,
        result: completion.result,
      },
      input: {
        from_a: completion.result,
        instruction: "请基于节点 A 的输出再做一次复述",
      },
    };
  },
};

const nodeB: Node = {
  kind: "code",
  id: "echo_b",
  subGoal: "收到节点 A 的输出，复述并上报",
  execute: createAgentExecute({
    prompt: (input) =>
      `上一节点产出: ${JSON.stringify(input.data.from_a)}\n指令: ${input.data.instruction}\n请基于此做一次复述并上报`,
  }),
};

const edgeB: Edge = {
  id: "b_to_end",
  from: "echo_b",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `节点 B 完成`,
        result: completion.result,
      },
    };
  },
};

const chainEntry: Entry = {
  id: "chain_entry",
  guard: () => true,
  startNodeId: "echo_a",
  mapInput: (bg) => bg,
};

export const chainGraph: Graph = {
  id: "chain_test",
  goal: "验证双节点链式推进",
  invocation: {
    name: "chain",
    description: "双节点链式测试",
    inputSchema: { type: "object", properties: { args: { type: "string" } } },
    parseArgs: (a) => ({ args: a || "无参数" }),
  },
  entries: [chainEntry],
  nodes: { echo_a: nodeA, echo_b: nodeB },
  routing: {
    echo_a: { nodeId: "echo_a", edges: [edgeA], router: { kind: "first-match" } },
    echo_b: { nodeId: "echo_b", edges: [edgeB], router: { kind: "first-match" } },
  },
};
