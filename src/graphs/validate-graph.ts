import { Type } from "typebox";
import { defineSingleAgentGraph } from "../builders/graph.js";
import { agentNode } from "../builders/node.js";

const Input = Type.Object({});
const Output = Type.Object({ question: Type.String(), answer: Type.String() });

export const validateGraph = defineSingleAgentGraph({
  id: "validate_test",
  version: "1",
  goal: "验证完成度检查机制",
  input: Input,
  output: Output,
  context: { background: { select: "none" } },
  node: agentNode({
    subGoal: "生成一道题目和答案",
    input: Input,
    output: Output,
    prompt: "生成一道题目和答案，并提交 question 与 answer。",
  }),
});
