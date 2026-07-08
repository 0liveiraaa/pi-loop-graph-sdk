import { describe, expect, it } from "vitest";
import { assertValidGraph, validateGraph } from "./validate.js";
import type { Edge, Entry, Graph, Node } from "./type.js";
import { END } from "./type.js";

function node(id: string): Node {
  return {
    kind: "code",
    id,
    subGoal: `${id} goal`,
    async execute() {
      return { nodeId: id, status: "ok", result: {} };
    },
  };
}

function edge(id: string, from: string, to: string | typeof END): Edge {
  return {
    id,
    from,
    to,
    priority: 1,
    guard: () => true,
    migrate(_instance, completion) {
      return {
        frame: {
          nodeId: completion.nodeId,
          status: completion.status,
          summary: id,
          result: completion.result,
        },
      };
    },
  };
}

function graph(overrides: Partial<Graph> = {}): Graph {
  const start = node("start");
  return {
    id: "validated_graph",
    goal: "validate graph",
    entries: [{ id: "main", guard: () => true, startNodeId: "start" }],
    nodes: { start },
    routing: {
      start: {
        nodeId: "start",
        edges: [edge("done", "start", END)],
        router: { kind: "first-match" },
      },
    },
    ...overrides,
  };
}

describe("validateGraph", () => {
  it("requires at least one entry", () => {
    expect(validateGraph(graph({ entries: [] }))).toMatchObject([
      { code: "NO_ENTRY", path: "entries" },
    ]);
  });

  it("reports entries that point at missing start nodes", () => {
    const entry: Entry = { id: "missing", guard: () => true, startNodeId: "missing_node" };

    expect(validateGraph(graph({ entries: [entry] }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ENTRY_TARGET_MISSING", path: "entries[missing]" }),
      ]),
    );
  });

  it("requires every node to own routing", () => {
    expect(validateGraph(graph({ routing: {} }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NODE_ROUTING_MISSING", path: "nodes.start" }),
      ]),
    );
  });

  it("reports routing node id mismatches and edge from mismatches", () => {
    expect(
      validateGraph(
        graph({
          routing: {
            start: {
              nodeId: "other",
              edges: [edge("wrong_from", "other", END)],
              router: { kind: "first-match" },
            },
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ROUTING_NODE_MISSING", path: "routing.start" }),
        expect.objectContaining({
          code: "EDGE_FROM_MISMATCH",
          path: "routing.start.edges[wrong_from]",
        }),
      ]),
    );
  });

  it("allows END targets and rejects missing node targets", () => {
    expect(validateGraph(graph())).toEqual([]);
    expect(
      validateGraph(
        graph({
          routing: {
            start: {
              nodeId: "start",
              edges: [edge("missing_to", "start", "missing_node")],
              router: { kind: "first-match" },
            },
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "EDGE_TARGET_MISSING",
          path: "routing.start.edges[missing_to]",
        }),
      ]),
    );
  });

  it("assertValidGraph includes all validation issue paths in its error", () => {
    expect(() => assertValidGraph(graph({ routing: {} }))).toThrow("nodes.start");
  });
});
