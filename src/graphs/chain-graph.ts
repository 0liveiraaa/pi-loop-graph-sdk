import { Type } from "typebox";
import { defineGraph } from "../builders/graph.js";
import { agentNode } from "../builders/node.js";
import { connect, entry, finish, firstMatch } from "../builders/route.js";

const Input = Type.Object({ args: Type.Optional(Type.String()) });
const AgentOutput = Type.Record(Type.String(), Type.Unknown());
const SecondInput = Type.Object({ fromA: AgentOutput, instruction: Type.String() });

const echoA = agentNode({
  subGoal: "接收用户输入并复述",
  input: Input,
  output: AgentOutput,
  prompt: "复述输入并提交结果。",
});
const echoB = agentNode({
  subGoal: "基于上一阶段的结果再次复述",
  input: SecondInput,
  output: AgentOutput,
  prompt: "基于 Node Focus 再次复述并提交结果。",
});

export const chainGraph = defineGraph({
  id: "chain_test",
  version: "1",
  goal: "验证双节点链式推进",
  input: Input,
  output: AgentOutput,
  context: { background: { select: "all" } },
  entries: [entry("chain-entry", { to: "echo-a" })],
  stages: {
    "echo-a": {
      node: echoA,
      route: firstMatch({
        next: connect("echo-b", {
          frame: ({ completion }) => ({ fromA: completion.result }),
          map: ({ completion }) => ({ fromA: completion.result, instruction: "再次复述" }),
        }),
      }),
    },
    "echo-b": {
      node: echoB,
      route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
    },
  },
});
