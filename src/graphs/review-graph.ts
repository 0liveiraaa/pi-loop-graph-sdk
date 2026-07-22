import { Type } from "typebox";
import { defineGraph } from "../builders/graph.js";
import { codeNode } from "../builders/node.js";
import { entry, finish, firstMatch } from "../builders/route.js";

const Input = Type.Object({ args: Type.Optional(Type.String()) });
const Output = Type.Object({ message: Type.String(), received: Input });

const echo = codeNode({
  subGoal: "确认接收到的参数并返回",
  input: Input,
  output: Output,
  execute: ({ input, complete }) => complete({
    message: `已收到参数: ${input.args ?? "(无参数)"}`,
    received: input,
  }),
});

export const reviewGraph = defineGraph({
  id: "review_echo_test",
  version: "1",
  goal: "验证 Loop Graph Runtime 闭环",
  input: Input,
  output: Output,
  context: { background: { select: "all" } },
  entries: [entry("echo-entry", { to: "echo" })],
  stages: {
    echo: {
      node: echo,
      route: firstMatch({
        done: finish({
          frame: ({ completion }) => ({ message: completion.result.message }),
          output: ({ completion }) => completion.result,
        }),
      }),
    },
  },
});
