import { describe, expect, it, vi } from "vitest";
import { GraphRegistry } from "./registry.js";
import type { Edge, Entry, Graph, Node } from "./type.js";
import { END } from "./type.js";

function fakePi() {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
  } as any;
}

function minimalGraph(name = "graph_cmd"): Graph {
  const node: Node = {
    kind: "code",
    id: "start",
    subGoal: "测试节点",
    async execute() {
      return { nodeId: "start", status: "ok", result: {} };
    },
  };

  const entry: Entry = {
    id: "main",
    guard: () => true,
    startNodeId: "start",
  };

  const edge: Edge = {
    id: "done",
    from: "start",
    to: END,
    priority: 10,
    guard: () => true,
    migrate(_instance, completion) {
      return {
        frame: {
          nodeId: completion.nodeId,
          status: completion.status,
          summary: "完成",
          result: completion.result,
        },
      };
    },
  };

  return {
    id: `graph_${name}`,
    goal: "测试图",
    invocation: {
      name,
      description: "测试命令",
      inputSchema: { type: "object", properties: {} },
      parseArgs: (args) => ({ parsed: args.trim(), via: "parseArgs" }),
    },
    entries: [entry],
    nodes: { start: node },
    routing: {
      start: { nodeId: "start", edges: [edge], router: { kind: "first-match" } },
    },
  };
}

describe("GraphRegistry", () => {
  it("parses command args before executing a graph", async () => {
    const pi = fakePi();
    const executeGraph = vi.fn().mockResolvedValue(undefined);
    const graph = minimalGraph("review_turn");
    const registry = new GraphRegistry(pi, executeGraph);

    registry.registerGraph(graph);

    const commandOptions = pi.registerCommand.mock.calls[0][1];
    await commandOptions.handler("  algebra  ", {
      ui: { notify: vi.fn() },
    });

    expect(executeGraph).toHaveBeenCalledWith(
      pi,
      graph,
      expect.objectContaining({
        source: "command",
        params: { parsed: "algebra", via: "parseArgs" },
      }),
    );
  });

  it("executes graph tools without relying on dynamic this binding", async () => {
    const pi = fakePi();
    const executeGraph = vi.fn().mockResolvedValue(undefined);
    const graph = minimalGraph("review_tool");
    const registry = new GraphRegistry(pi, executeGraph);

    registry.registerGraph(graph);

    const toolDefinition = pi.registerTool.mock.calls[0][0];
    await expect(
      toolDefinition.execute("tool-call-1", { subject: "math" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: `图 "${graph.id}" 执行完成` }],
      details: {},
    });

    expect(executeGraph).toHaveBeenCalledWith(pi, graph, {
      source: "tool",
      params: { subject: "math" },
    });
  });
});
