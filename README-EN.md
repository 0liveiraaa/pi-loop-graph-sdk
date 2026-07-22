# pi-loop-graph-sdk

The 0.2 SDK for building typed, routed graphs for Pi. The root package contains stable graph builders, hosts, result types, and the Pi extension factory. Low-level runtime and adapter APIs are opt-in under `pi-loop-graph-sdk/advanced`; replay utilities are under `/replay`.

```ts
import { Type } from "typebox";
import { codeNode, createGraphHost, defineGraph, entry, finish, firstMatch } from "pi-loop-graph-sdk";
const Input = Type.Object({ name: Type.String() });
const Output = Type.Object({ message: Type.String() });
const graph = defineGraph({
  id: "hello", version: "1", goal: "greet", input: Input, output: Output,
  context: { background: { select: "all" } },
  entries: [entry("main", { to: "greet" })],
  stages: { greet: { node: codeNode({ subGoal: "greet", input: Input, output: Output,
    execute: ({ input, complete }) => complete({ message: `Hello, ${input.name}` }), }),
    route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }) } },
});
const result = await createGraphHost().execute(graph, { name: "World" });
```

Model completion is strictly `__graph_complete__({ result })`; Runtime owns status and failures are returned as `GraphRunResult.failure`. Phase 10 currently supports reliable single-layer Root checkpoint/resume only. Nested continuation recovery remains fail-closed. Set `PI_LIVE_TESTS=1` for live LLM tests.

Graph exposures created with `exposeGraph()` run in an isolated Pi Session by default. Use `execution: "current-session"` only when sharing the caller's session state is intentional. The packaged `/extension` entry installs the base runtime and does not register demo graphs.
