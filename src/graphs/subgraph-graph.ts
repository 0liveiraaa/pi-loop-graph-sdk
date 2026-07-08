// ============================================================
//  子图隔离测试图
// ============================================================
//  父图: entry → sub_wrapper(graph) → END
//  子图: entry → child_agent → END
//
//  验证：
//    1. 子图运行时 context 不含父图帧（隔离）
//    2. 子图结束后父图将其归约为一帧
//    3. 父图 END 时帧栈只有 1 帧（子图内部帧对父图不可见）
// ============================================================

import type {
  Edge,
  Entry,
  Graph,
  Node,
  NodeCompletion,
  NodeRouting,
} from "../type.js";
import { END } from "../type.js";

// ── 子图 ──────────────────────────────────────────────────

const childAgent: Node = {
  kind: "code",
  id: "child_agent",
  subGoal: "这是子图内部的 agent 节点，复述输入并上报",
  skill: "__probe_skill__",
  execute: null as any,
};

const childEntry: Entry = {
  id: "child_entry",
  guard: () => true,
  startNodeId: "child_agent",
  mapInput: (bg) => bg,
};

const childEdge: Edge = {
  id: "child_to_end",
  from: "child_agent",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `子图 agent 完成: ${JSON.stringify(completion.result).slice(0, 60)}`,
        result: completion.result,
      },
    };
  },
};

const childGraph: Graph = {
  id: "sub_child",
  goal: "子图内部任务",
  entries: [childEntry],
  nodes: { child_agent: childAgent },
  routing: {
    child_agent: {
      nodeId: "child_agent",
      edges: [childEdge],
      router: { kind: "first-match" },
    },
  },
};

// ── 父图 ──────────────────────────────────────────────────

const subWrapperNode: Node = {
  kind: "graph",
  id: "sub_wrapper",
  subGoal: "委托子图执行",
  graph: childGraph,
};

const parentEntry: Entry = {
  id: "parent_entry",
  guard: () => true,
  startNodeId: "sub_wrapper",
  mapInput: (bg) => bg,
};

const parentEdge: Edge = {
  id: "wrapper_to_end",
  from: "sub_wrapper",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `子图 wrapper 完成`,
        result: completion.result,
      },
    };
  },
};

export const subgraphGraph: Graph = {
  id: "subgraph_test",
  goal: "验证子图隔离",
  invocation: {
    name: "sub",
    description: "子图隔离测试",
    inputSchema: { type: "object", properties: { args: { type: "string" } } },
    parseArgs: (a) => ({ args: a || "默认输入" }),
  },
  entries: [parentEntry],
  nodes: { sub_wrapper: subWrapperNode },
  routing: {
    sub_wrapper: {
      nodeId: "sub_wrapper",
      edges: [parentEdge],
      router: { kind: "first-match" },
    },
  },
};
