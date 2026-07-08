import { describe, expect, it } from "vitest";
import { GraphRuntime } from "./runtime.js";
import type { Edge, Entry, Graph, Node } from "./type.js";
import { END } from "./type.js";

function minimalGraph(): Graph {
  const node: Node = {
    kind: "code",
    id: "start",
    subGoal: "start node",
    async execute() {
      return { nodeId: "start", status: "ok", result: {} };
    },
  };

  const entry: Entry = {
    id: "main",
    guard: () => true,
    startNodeId: "start",
  };

  const done: Edge = {
    id: "done",
    from: "start",
    to: END,
    priority: 1,
    guard: () => true,
    migrate(_instance, completion) {
      return {
        frame: {
          nodeId: completion.nodeId,
          status: completion.status,
          summary: "done",
          result: completion.result,
        },
      };
    },
  };

  return {
    id: "runtime_graph",
    goal: "runtime goal",
    entries: [entry],
    nodes: { start: node },
    routing: {
      start: { nodeId: "start", edges: [done], router: { kind: "first-match" } },
    },
  };
}

describe("GraphRuntime", () => {
  it("pushGraph creates an isolated agent instance for the graph", () => {
    const runtime = new GraphRuntime();
    const background = { subject: "review" };
    const graph = minimalGraph();

    const instance = runtime.pushGraph(graph, background);

    expect(instance.globalGoal).toBe(graph.goal);
    expect(instance.background).toBe(background);
    expect(instance.frames).toEqual([]);
    expect(instance.mechanisms).toEqual([]);
    expect(runtime.topInstance).toBe(instance);
    expect(runtime.topGraph).toBe(graph);
  });

  it("creates unique boundary markers even when entering the same node repeatedly", () => {
    const runtime = new GraphRuntime();

    const first = runtime.nextMarker("start");
    const second = runtime.nextMarker("start");

    expect(first).toMatch(/^__node_boundary__:start:1:/);
    expect(second).toMatch(/^__node_boundary__:start:2:/);
    expect(second).not.toBe(first);
  });

  it("enterNode activates only current transient node state and exitNode folds it into frames", () => {
    const runtime = new GraphRuntime();
    runtime.pushGraph(minimalGraph(), { subject: "review" });
    const input = { data: { topic: "sdk" }, source: { kind: "entry" as const, entryId: "main" } };

    const node = runtime.enterNode("start", "marker-1", input);

    expect(node.id).toBe("start");
    expect(runtime.currentNodeId).toBe("start");
    expect(runtime.currentInput).toBe(input);
    expect(runtime.nodeMarker).toBe("marker-1");
    expect(runtime.isNodeActive).toBe(true);

    const frame = {
      nodeId: "start",
      status: "ok" as const,
      summary: "done",
      result: { value: 1 },
    };
    runtime.exitNode(frame);

    expect(runtime.topInstance?.frames).toEqual([frame]);
    expect(runtime.isNodeActive).toBe(false);
    expect(runtime.currentNode).toBeNull();
    expect(runtime.currentInput).toBeNull();
    expect(runtime.nodeMarker).toBeNull();
  });

  it("reset clears graph stack and transient node state", () => {
    const runtime = new GraphRuntime();
    runtime.pushGraph(minimalGraph(), {});
    runtime.enterNode("start", runtime.nextMarker("start"), {
      data: {},
      source: { kind: "entry", entryId: "main" },
    });

    runtime.reset();

    expect(runtime.callStack).toEqual([]);
    expect(runtime.top).toBeNull();
    expect(runtime.isNodeActive).toBe(false);
    expect(runtime.currentNode).toBeNull();
    expect(runtime.currentInput).toBeNull();
    expect(runtime.nodeMarker).toBeNull();
  });
});
