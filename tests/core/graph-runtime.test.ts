import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineGraph, defineLinearGraph, defineSingleAgentGraph } from "../../src/builders/graph.js";
import { agentNode, codeNode, graphNode } from "../../src/builders/node.js";
import { connect, entry, finish, firstMatch } from "../../src/builders/route.js";
import { graphRef } from "../../src/core/graph.js";
import { GraphRuntime } from "../../src/runtime/graph-runtime.js";

const Value = Type.Object({ value: Type.Number() });

function incrementGraph() {
  const increment = codeNode({
    subGoal: "increment",
    input: Value,
    output: Value,
    execute: ({ input, complete }) => complete({ value: input.value + 1 }),
  });
  return defineGraph({
    id: "increment",
    version: "1",
    goal: "increment",
    input: Value,
    output: Value,
    context: { background: { select: "all" } },
    entries: [entry("main", { to: "first" })],
    stages: {
      first: {
        node: increment,
        route: firstMatch({
          again: connect("second", { map: ({ completion }) => completion.result }),
        }),
      },
      second: {
        node: increment,
        route: firstMatch({
          done: finish({ output: ({ completion }) => completion.result }),
        }),
      },
    },
  });
}

describe("GraphRuntime", () => {
  it("validates Graph input before Entry evaluation", async () => {
    await expect(new GraphRuntime().execute(incrementGraph(), { value: "bad" } as never)).resolves.toMatchObject({
      status: "failed",
      steps: 0,
      failure: { code: "invalid-input", phase: "graph" },
    });
  });

  it("rejects non-finite, non-plain, and cyclic values at JSON boundaries", async () => {
    const Unknown = Type.Unknown();
    const graph = defineGraph({
      id: "strict-json-input",
      version: "1",
      goal: "validate JSON compatibility",
      input: Unknown,
      output: Unknown,
      context: { background: { select: "none" } },
      entries: [entry<unknown>("main", { to: "node" })],
      stages: {
        node: {
          node: codeNode({
            subGoal: "identity",
            input: Unknown,
            output: Unknown,
            execute: ({ input, complete }) => complete(input),
          }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result as never }) }),
        },
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const input of [Number.NaN, Number.POSITIVE_INFINITY, new Date(), cyclic]) {
      await expect(new GraphRuntime().execute(graph, input)).resolves.toMatchObject({
        status: "failed",
        steps: 0,
        failure: { code: "invalid-input", phase: "graph" },
      });
    }
  });

  it("validates mapped Node input before executing the Node", async () => {
    let executed = false;
    const graph = defineGraph({
      id: "invalid-node-input",
      version: "1",
      goal: "validate",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "node", mapInput: () => ({ value: "bad" }) })],
      stages: {
        node: {
          node: codeNode({
            subGoal: "never run",
            input: Value,
            output: Value,
            execute: ({ input, complete }) => {
              executed = true;
              return complete(input);
            },
          }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });

    await expect(new GraphRuntime().execute(graph, { value: 1 })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "invalid-input", phase: "node", stageId: "node" },
    });
    expect(executed).toBe(false);
  });

  it("rejects invalid Node completion and Graph finish output", async () => {
    const invalidNode = defineGraph({
      id: "invalid-node-output",
      version: "1",
      goal: "validate",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "node" })],
      stages: {
        node: {
          node: codeNode({
            subGoal: "bad output",
            input: Value,
            output: Value,
            execute: ({ complete }) => complete({ value: "bad" } as never),
          }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    await expect(new GraphRuntime().execute(invalidNode, { value: 1 })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "validation-exhausted", phase: "node", stageId: "node" },
    });

    const invalidFinish = defineGraph({
      id: "invalid-graph-output",
      version: "1",
      goal: "validate",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "node" })],
      stages: {
        node: {
          node: codeNode({ subGoal: "valid", input: Value, output: Value, execute: ({ input, complete }) => complete(input) }),
          route: firstMatch({ done: finish({ output: () => ({ value: "bad" }) as never }) }),
        },
      },
    });
    await expect(new GraphRuntime().execute(invalidFinish, { value: 1 })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "validation-exhausted", phase: "graph", stageId: "node" },
    });
  });

  it("executes stages and explicit finish output", async () => {
    await expect(new GraphRuntime().execute(incrementGraph(), { value: 1 })).resolves.toMatchObject({
      status: "completed",
      output: { value: 3 },
      steps: 2,
    });
  });

  it("resolves recursive graph nodes through GraphRef", async () => {
    const child = incrementGraph();
    const parent = defineGraph({
      id: "parent",
      version: "1",
      goal: "call child",
      input: Value,
      output: Value,
      context: { background: { select: "all" } },
      entries: [entry("main", { to: "child" })],
      stages: {
        child: {
          node: graphNode({ subGoal: "child", input: Value, output: Value, graph: graphRef("increment", "1") }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const runtime = new GraphRuntime({ resolveGraph: (ref) => ref.id === child.id && ref.version === child.version ? child : undefined });
    await expect(runtime.execute(parent, { value: 1 })).resolves.toMatchObject({ output: { value: 3 } });
  });

  it("executes single-agent and linear Builder output with the same Runtime", async () => {
    const agent = agentNode({
      identity: { name: "report" },
      subGoal: "report",
      input: Value,
      output: Value,
      prompt: "report",
    });
    const single = defineSingleAgentGraph({
      id: "single",
      version: "1",
      goal: "single",
      input: Value,
      output: Value,
      context: { background: { select: "all" } },
      node: agent,
    });
    const linear = defineLinearGraph({
      id: "linear",
      version: "1",
      goal: "linear",
      input: Value,
      output: Value,
      context: { background: { select: "all" } },
      nodes: [incrementGraph().stages.first.node, agent],
    });
    const runtime = new GraphRuntime({
      runAgent: async (_node, input) => input,
    });

    await expect(runtime.execute(single, { value: 2 })).resolves.toMatchObject({ output: { value: 2 } });
    await expect(runtime.execute(linear, { value: 2 })).resolves.toMatchObject({ output: { value: 3 } });
  });
});
