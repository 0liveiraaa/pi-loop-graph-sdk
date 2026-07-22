import type { TSchema } from "typebox";
import type { Graph, GraphDefinition, NodeDefinition, Stage } from "../core/graph.js";
import { defineGraph } from "../core/graph.js";

export { defineGraph } from "../core/graph.js";

export function defineSingleAgentGraph<TInputSchema extends TSchema, TOutputSchema extends TSchema, TBackground extends import("../core/json.js").JsonValue, TMemory extends import("../core/json.js").JsonValue = import("../core/json.js").JsonValue>(input: {
  id: string;
  version: string;
  goal: string;
  input: TInputSchema;
  output: TOutputSchema;
  context: GraphDefinition<TInputSchema, TOutputSchema, TBackground, TMemory>["context"];
  node: Extract<NodeDefinition, { kind: "agent" }>;
  tools?: GraphDefinition<TInputSchema, TOutputSchema>["tools"];
  skills?: GraphDefinition<TInputSchema, TOutputSchema>["skills"];
}): Graph<TInputSchema, TOutputSchema, TBackground, TMemory> {
  const stages: Record<string, Stage> = {
    main: {
      node: input.node,
      route: {
        kind: "first-match",
        connections: [{
          id: "finish",
          to: "__graph_finish__",
          transition: { output: ({ completion }) => completion.result },
        }],
      },
    },
  };
  return defineGraph({ ...input, entries: [{ id: "main", to: "main" }], stages } as GraphDefinition<TInputSchema, TOutputSchema, TBackground, TMemory>);
}

export function defineLinearGraph<TInputSchema extends TSchema, TOutputSchema extends TSchema, TBackground extends import("../core/json.js").JsonValue, TMemory extends import("../core/json.js").JsonValue = import("../core/json.js").JsonValue>(input: {
  id: string;
  version: string;
  goal: string;
  input: TInputSchema;
  output: TOutputSchema;
  context: GraphDefinition<TInputSchema, TOutputSchema, TBackground, TMemory>["context"];
  nodes: readonly NodeDefinition[];
  tools?: GraphDefinition<TInputSchema, TOutputSchema>["tools"];
  skills?: GraphDefinition<TInputSchema, TOutputSchema>["skills"];
}): Graph<TInputSchema, TOutputSchema, TBackground, TMemory> {
  const stages: Record<string, Stage> = {};
  input.nodes.forEach((node, index) => {
    const id = node.identity?.name ?? `stage-${index + 1}`;
    const next = input.nodes[index + 1]?.identity?.name ?? (index + 1 < input.nodes.length ? `stage-${index + 2}` : "__graph_finish__");
    stages[id] = {
      node,
      route: {
        kind: "first-match",
        connections: [{
          id: next === "__graph_finish__" ? "finish" : `to-${next}`,
          to: next,
          transition: next === "__graph_finish__"
            ? { output: ({ completion }) => completion.result }
            : { map: ({ completion }) => completion.result },
        }],
      },
    };
  });
  return defineGraph({ ...input, entries: [{ id: "main", to: Object.keys(stages)[0] ?? "" }], stages } as GraphDefinition<TInputSchema, TOutputSchema, TBackground, TMemory>);
}
