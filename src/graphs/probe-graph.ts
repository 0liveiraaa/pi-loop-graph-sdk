import { Type } from "typebox";
import { defineSingleAgentGraph } from "../builders/graph.js";
import { agentNode } from "../builders/node.js";

const Input = Type.Object({});
const Output = Type.Record(Type.String(), Type.Unknown());

export const probeGraph = defineSingleAgentGraph({
  id: "probe_test",
  version: "1",
  goal: "验证 Node Focus 可见性",
  input: Input,
  output: Output,
  context: { background: { select: "none" } },
  node: agentNode({
    subGoal: "列出当前可见的 Graph、Memory 与 Node 上下文",
    input: Input,
    output: Output,
    prompt: "列出当前可见上下文，然后提交结构化结果。",
  }),
});
