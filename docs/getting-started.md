# Getting started

Install the package and define a graph with TypeBox schemas and the 0.2 builders. A graph has entries, stages, a typed node, and an explicit route to `finish`.

```ts
import { Type } from "typebox";
import { codeNode, createGraphHost, defineGraph, entry, finish, firstMatch } from "pi-loop-graph-sdk";

const Input = Type.Object({ value: Type.Number() });
const Output = Type.Object({ doubled: Type.Number() });
const graph = defineGraph({
  id: "double", version: "1", goal: "double a value", input: Input, output: Output,
  entries: [entry("main", { to: "double" })],
  stages: { double: { node: codeNode({ subGoal: "double", input: Input, output: Output,
    execute: ({ input, complete }) => complete({ doubled: input.value * 2 }), }),
    route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }) } },
});

const host = createGraphHost();
const result = await host.execute(graph, { value: 21 });
if (result.status === "completed") console.log(result.output.doubled);
else console.error(result.failure);
```

Use `agentNode` for Pi-backed work, `graphNode` plus `graphRef` for call/compose/delegate boundaries, and `createLoopGraphExtension(pi)` to expose graphs as Pi commands/tools. See the migration guide for 0.1 differences.
