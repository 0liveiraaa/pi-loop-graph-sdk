// ============================================================
//  哨兵探针测试图
// ============================================================

import type { Edge, Entry, Graph, Node, NodeCompletion, NodeRouting } from "../type.js";
import { END } from "../type.js";
import { createAgentExecute } from "../agent-execute.js";

const probeNode: Node = {
  kind: "code",
  id: "probe",
  subGoal: "验证哨兵消息是否出现在 context 数组里",
  execute: createAgentExecute(),
};

const probeEntry: Entry = {
  id: "probe_entry",
  guard: () => true,
  startNodeId: "probe",
};

const probeEdge: Edge = {
  id: "probe_to_end",
  from: "probe",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: "探针完成",
        result: completion.result,
      },
    };
  },
};

export const probeGraph: Graph = {
  id: "probe_test",
  goal: "验证哨兵可见性",
  invocation: {
    name: "probe",
    description: "哨兵探针测试",
    inputSchema: { type: "object", properties: {} },
  },
  entries: [probeEntry],
  nodes: { probe: probeNode },
  routing: {
    probe: {
      nodeId: "probe",
      edges: [probeEdge],
      router: { kind: "first-match" },
    },
  },
};
