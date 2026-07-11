// ============================================================
//  NodeScope 探针测试图
// ============================================================

import type { Edge, Entry, Graph, Node, NodeCompletion, NodeRouting } from "../type.js";
import { END } from "../type.js";
import { createAgentExecute } from "../agent-execute.js";

const probeNode: Node = {
  kind: "code",
  id: "probe",
  subGoal: "验证 NodeScope 消息是否出现在 context 数组里",
  execute: createAgentExecute({
    prompt: "请列出现在你看到的上下文信息，包括 COMPLETED 段和 CURRENT 段的内容，然后调用 __graph_complete__ 上报",
  }),
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
  goal: "验证 NodeScope 可见性",
  invocation: {
    name: "probe",
    description: "NodeScope 探针测试",
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
