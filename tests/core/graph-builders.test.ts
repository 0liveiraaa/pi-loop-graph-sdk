import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineGraph, defineLinearGraph, defineSingleAgentGraph } from "../../src/builders/graph.js";
import { agentNode, codeNode } from "../../src/builders/node.js";
import { connect, entry, finish, firstMatch } from "../../src/builders/route.js";
import { graphRef } from "../../src/core/graph.js";

const Input = Type.Object({ value: Type.Number() });
const Output = Type.Object({ value: Type.Number() });

const increment = codeNode({
  identity: { name: "increment", version: "1" },
  subGoal: "Increment the value",
  input: Input,
  output: Output,
  execute: ({ input, complete }) => complete({ value: input.value + 1 }),
});

const report = agentNode({
  identity: { name: "report", version: "1" },
  subGoal: "Report the value",
  input: Output,
  output: Output,
  prompt: "Return the value.",
});

describe("Phase 1 graph builders", () => {
  it("builds and shallow-freezes a Core Graph with one Stage identity", () => {
    const graph = defineGraph({
      id: "increment",
      version: "1",
      goal: "Increment once",
      input: Input,
      output: Output,
      context: { background: { select: "all" } },
      entries: [entry("main", { to: "increment" })],
      stages: {
        increment: {
          node: increment,
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });

    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.stages)).toBe(true);
    expect(Object.isFrozen(graph.stages.increment.route.connections)).toBe(true);
    expect(graph.stages.increment.node).not.toHaveProperty("id");
  });

  it("rejects missing Stage targets and implicit finish output", () => {
    expect(() => defineGraph({
      id: "missing",
      version: "1",
      goal: "Missing target",
      input: Input,
      output: Output,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "missing" })],
      stages: {},
    })).toThrow(/missing Stage/i);

    expect(() => defineGraph({
      id: "implicit",
      version: "1",
      goal: "Implicit finish",
      input: Input,
      output: Output,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "increment" })],
      stages: {
        increment: {
          node: increment,
          route: { kind: "first-match", connections: [{ id: "done", to: "__graph_finish__", transition: {} }] },
        },
      },
    })).toThrow(/explicit output mapper/i);
  });

  it("rejects duplicate Entry and Connection identities", () => {
    expect(() => defineGraph({
      id: "duplicates",
      version: "1",
      goal: "duplicates",
      input: Input,
      output: Output,
      context: { background: { select: "none" } },
      entries: [entry("same", { to: "increment" }), entry("same", { to: "increment" })],
      stages: {
        increment: {
          node: increment,
          route: {
            kind: "first-match",
            connections: [
              { id: "same", to: "__graph_finish__", transition: { output: ({ completion }) => completion.result } },
              { id: "same", to: "__graph_finish__", transition: { output: ({ completion }) => completion.result } },
            ],
          },
        },
      },
    })).toThrow(/Duplicate Entry ID/);

    expect(() => defineGraph({
      id: "duplicate-connections",
      version: "1",
      goal: "duplicates",
      input: Input,
      output: Output,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "increment" })],
      stages: {
        increment: {
          node: increment,
          route: {
            kind: "first-match",
            connections: [
              { id: "same", to: "__graph_finish__", transition: { output: ({ completion }) => completion.result } },
              { id: "same", to: "__graph_finish__", transition: { output: ({ completion }) => completion.result } },
            ],
          },
        },
      },
    })).toThrow(/Duplicate Connection ID/);
  });

  it("builds single-agent and linear graphs into the same Core stages", () => {
    const single = defineSingleAgentGraph({
      id: "single",
      version: "1",
      goal: "Report",
      input: Output,
      output: Output,
      context: { background: { select: "all" } },
      node: report,
    });
    const linear = defineLinearGraph({
      id: "linear",
      version: "1",
      goal: "Increment and report",
      input: Input,
      output: Output,
      context: { background: { select: "all" } },
      nodes: [increment, report],
    });

    expect(Object.keys(single.stages)).toEqual(["main"]);
    expect(Object.keys(linear.stages)).toEqual(["increment", "report"]);
    expect(linear.stages.increment.route.connections[0]).toMatchObject({ to: "report" });
    expect(linear.stages.report.route.connections[0]).toMatchObject({ to: "__graph_finish__" });
  });

  it("creates stable GraphRef values and rejects incomplete refs", () => {
    expect(graphRef("child", "2")).toEqual({ id: "child", version: "2" });
    expect(() => graphRef("", "2")).toThrow(/requires id and version/i);
  });
});
