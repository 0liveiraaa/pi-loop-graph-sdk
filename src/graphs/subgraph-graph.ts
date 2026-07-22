import { Type } from "typebox";
import { defineGraph, defineSingleAgentGraph } from "../builders/graph.js";
import { agentNode, graphNode } from "../builders/node.js";
import { entry, finish, firstMatch } from "../builders/route.js";
import { graphRef } from "../core/graph.js";

const Input = Type.Object({ args: Type.Optional(Type.String()) });
const Output = Type.Record(Type.String(), Type.Unknown());

export const childGraph = defineSingleAgentGraph({
  id: "sub_child",
  version: "1",
  goal: "子图内部任务",
  input: Input,
  output: Output,
  context: { background: { select: "all" } },
  node: agentNode({
    subGoal: "复述子图输入",
    input: Input,
    output: Output,
    prompt: "复述输入并提交结果。",
  }),
});

export const subgraphGraph = defineGraph({
  id: "subgraph_test",
  version: "1",
  goal: "验证子图隔离",
  input: Input,
  output: Output,
  context: { background: { select: "all" } },
  entries: [entry("parent-entry", { to: "child" })],
  stages: {
    child: {
      node: graphNode({
        subGoal: "委托子图执行",
        input: Input,
        output: Output,
        graph: graphRef(childGraph.id, childGraph.version),
      }),
      route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
    },
  },
});
