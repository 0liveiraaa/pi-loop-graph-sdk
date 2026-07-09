import { describe, expect, it } from "vitest";
import { assertValidGraph, validateGraph, validateGraphTools } from "./validate.js";
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

// ── validateGraphTools ──

function nodeWithTools(id: string, tools?: string[]): Node {
  return {
    kind: "code",
    id,
    subGoal: `${id} goal`,
    tools,
    async execute() {
      return { nodeId: id, status: "ok", result: {} };
    },
  };
}

describe("validateGraphTools", () => {
  it("passes when tools are clean", () => {
    const g: Graph = {
      id: "clean",
      goal: "clean",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: { a: nodeWithTools("a", ["tool1", "tool2"]) },
      routing: {
        a: { nodeId: "a", edges: [edge("done", "a", END)], router: { kind: "first-match" } },
      },
    };
    expect(validateGraphTools(g, [])).toEqual([]);
  });

  it("passes when defaultTools overlaps with node.tools", () => {
    const g: Graph = {
      id: "overlap",
      goal: "overlap",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: { a: nodeWithTools("a", ["shared", "unique"]) },
      routing: {
        a: { nodeId: "a", edges: [edge("done", "a", END)], router: { kind: "first-match" } },
      },
    };
    // defaultTools 与 node.tools 的重叠是故意注入，不应报错
    expect(validateGraphTools(g, ["shared"])).toEqual([]);
  });

  it("detects duplicate tool name within a single node", () => {
    const g: Graph = {
      id: "dup",
      goal: "dup",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: { a: nodeWithTools("a", ["review_card", "review_card"]) },
      routing: {
        a: { nodeId: "a", edges: [edge("done", "a", END)], router: { kind: "first-match" } },
      },
    };
    const issues = validateGraphTools(g, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "DUPLICATE_TOOL_IN_NODE",
      path: "nodes.a.tools",
    });
    expect(issues[0].message).toContain("review_card");
  });

  it("detects multiple duplicates", () => {
    const g: Graph = {
      id: "multi_dup",
      goal: "multi dup",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: {
        a: nodeWithTools("a", ["x", "y", "x"]),
        b: nodeWithTools("b", ["z", "z", "w"]),
      },
      routing: {
        a: { nodeId: "a", edges: [edge("a_to_b", "a", "b")], router: { kind: "first-match" } },
        b: { nodeId: "b", edges: [edge("done", "b", END)], router: { kind: "first-match" } },
      },
    };
    const issues = validateGraphTools(g, []);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.code)).toEqual([
      "DUPLICATE_TOOL_IN_NODE",
      "DUPLICATE_TOOL_IN_NODE",
    ]);
  });

  it("skips non-code nodes", () => {
    const childGraph: Graph = {
      id: "child",
      goal: "child",
      entries: [{ id: "e", guard: () => true, startNodeId: "inner" }],
      nodes: {
        inner: nodeWithTools("inner", ["dup", "dup"]),
      },
      routing: {
        inner: {
          nodeId: "inner",
          edges: [edge("done", "inner", END)],
          router: { kind: "first-match" },
        },
      },
    };

    const g: Graph = {
      id: "with_graph_node",
      goal: "with graph node",
      entries: [{ id: "e", guard: () => true, startNodeId: "composite" }],
      nodes: {
        composite: { kind: "graph", id: "composite", subGoal: "delegate", graph: childGraph },
      },
      routing: {
        composite: {
          nodeId: "composite",
          edges: [edge("done", "composite", END)],
          router: { kind: "first-match" },
        },
      },
    };
    // kind: "graph" 节点没有 tools，校验应跳过
    expect(validateGraphTools(g, [])).toEqual([]);
  });

  it("checks tool existence when registeredNames is provided", () => {
    const g: Graph = {
      id: "missing_tool",
      goal: "missing",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: { a: nodeWithTools("a", ["fake_tool"]) },
      routing: {
        a: { nodeId: "a", edges: [edge("done", "a", END)], router: { kind: "first-match" } },
      },
    };
    const issues = validateGraphTools(g, [], new Set(["real_tool"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "TOOL_NOT_REGISTERED",
      path: "nodes.a.tools",
    });
    expect(issues[0].message).toContain("fake_tool");
  });

  it("passes existence check when all tools are registered", () => {
    const g: Graph = {
      id: "all_registered",
      goal: "all ok",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: { a: nodeWithTools("a", ["tool_a", "tool_b"]) },
      routing: {
        a: { nodeId: "a", edges: [edge("done", "a", END)], router: { kind: "first-match" } },
      },
    };
    expect(
      validateGraphTools(g, [], new Set(["tool_a", "tool_b"])),
    ).toEqual([]);
  });

  it("does not flag read and __graph_complete__ as unregistered", () => {
    const g: Graph = {
      id: "framework_tools",
      goal: "framework",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: {
        a: nodeWithTools("a", ["read", "__graph_complete__", "my_tool"]),
      },
      routing: {
        a: { nodeId: "a", edges: [edge("done", "a", END)], router: { kind: "first-match" } },
      },
    };
    // read 和 __graph_complete__ 是框架内置工具，不应要求注册
    const issues = validateGraphTools(g, [], new Set(["my_tool"]));
    expect(issues).toEqual([]);
  });

  it("defaultTools 中的工具也参与存在性校验", () => {
    const g: Graph = {
      id: "default_check",
      goal: "default",
      entries: [{ id: "e", guard: () => true, startNodeId: "a" }],
      nodes: { a: nodeWithTools("a", ["node_tool"]) },
      routing: {
        a: { nodeId: "a", edges: [edge("done", "a", END)], router: { kind: "first-match" } },
      },
    };
    // defaultTools 中的 global_tool 未注册 → 应报错
    const issues = validateGraphTools(g, ["global_tool"], new Set(["node_tool"]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("global_tool");
  });
});
