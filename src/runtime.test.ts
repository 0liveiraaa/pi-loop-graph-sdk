import { describe, expect, it } from "vitest";
import { GraphRuntime } from "./runtime.js";
import type { ContextFrame, Edge, Entry, Graph, Node } from "./type.js";
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

  it("creates unique semantic scopes even when entering the same node repeatedly", () => {
    const runtime = new GraphRuntime();
    runtime.pushGraph(minimalGraph(), {});

    const first = runtime.nextScope("start");
    const second = runtime.nextScope("start");

    expect(first).toMatchObject({ protocol: 2, nodeId: "start", visit: 1 });
    expect(second).toMatchObject({ protocol: 2, nodeId: "start", visit: 2 });
    expect(second.scopeId).not.toBe(first.scopeId);
  });

  it("keeps visit counters per call frame while exposing nested depth", () => {
    const runtime = new GraphRuntime();
    const parent = minimalGraph();
    const child = minimalGraph();
    runtime.pushGraph(parent, {}, "root");
    expect(runtime.nextScope("start")).toMatchObject({ visit: 1, depth: 1 });

    runtime.pushGraph(child, {}, "call");
    expect(runtime.nextScope("start")).toMatchObject({ visit: 1, depth: 2 });
    runtime.popGraph();

    expect(runtime.nextScope("start")).toMatchObject({ visit: 2, depth: 1 });
  });

  it("popping a nested graph restores the active parent node scope", () => {
    const runtime = new GraphRuntime();
    const parent = minimalGraph();
    const child = minimalGraph();
    runtime.pushGraph(parent, {}, "root");
    const parentScope = runtime.nextScope("start");
    const parentInput = { data: { parent: true }, source: { kind: "entry" as const, entryId: "main" } };
    runtime.enterNode("start", parentScope, parentInput);

    runtime.pushGraph(child, {}, "call");
    const childScope = runtime.nextScope("start");
    runtime.enterNode("start", childScope, {
      data: { child: true }, source: { kind: "entry", entryId: "main" },
    });
    runtime.exitNode({ nodeId: "start", status: "ok", summary: "child", result: {} });
    runtime.popGraph();

    expect(runtime.isNodeActive).toBe(true);
    expect(runtime.currentScope).toBe(parentScope);
    expect(runtime.currentInput).toBe(parentInput);
    expect(runtime.currentNode?.id).toBe("start");
  });

  it("reads an immutable compose segment and closes it back to the baseline", () => {
    const runtime = new GraphRuntime();
    const parent = minimalGraph();
    runtime.pushGraph(parent, {}, "root");
    const instance = runtime.topInstance!;
    instance.frames.push({ nodeId: "parent", status: "ok", summary: "parent", result: { preserved: true } });
    const segment = runtime.beginFrameSegment("child", "compose");
    instance.frames.push({
      nodeId: "child", status: "ok", summary: "child", result: { nested: { value: 1 } },
    });

    const snapshot = runtime.readFrameSegment(segment);
    expect(snapshot).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0].result)).toBe(true);
    expect(Object.isFrozen((snapshot[0].result as any).nested)).toBe(true);
    expect(() => (snapshot as ContextFrame[]).push(instance.frames[0])).toThrow();
    expect(() => { (snapshot[0].result as any).nested.value = 2; }).toThrow();
    expect(instance.frames[1].result).toEqual({ nested: { value: 1 } });

    runtime.closeFrameSegment(segment, { nodeId: "compose", status: "ok", result: {} });
    expect(instance.frames).toEqual([
      { nodeId: "parent", status: "ok", summary: "parent", result: { preserved: true } },
    ]);
  });

  it("enterNode activates only current transient node state and exitNode folds it into frames", () => {
    const runtime = new GraphRuntime();
    runtime.pushGraph(minimalGraph(), { subject: "review" });
    const input = { data: { topic: "sdk" }, source: { kind: "entry" as const, entryId: "main" } };

    const scope = runtime.nextScope("start");
    const node = runtime.enterNode("start", scope, input);

    expect(node.id).toBe("start");
    expect(runtime.currentNodeId).toBe("start");
    expect(runtime.currentInput).toBe(input);
    expect(runtime.currentScope).toBe(scope);
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
    expect(runtime.currentScope).toBeNull();
  });

  it("compaction 只推进模型投影基线，不删除 Runtime 完整 frames", () => {
    const runtime = new GraphRuntime();
    const instance = runtime.pushGraph(minimalGraph(), {}, "root");
    instance.frames.push({ memory: "before compaction" });

    runtime.recordCompaction();
    expect(instance.frames).toEqual([{ memory: "before compaction" }]);
    expect(runtime.projectedFrames).toEqual([]);

    instance.frames.push({ memory: "after compaction" });
    expect(runtime.projectedFrames).toEqual([{ memory: "after compaction" }]);
  });

  it("records compaction generations without changing the active scope identity", () => {
    const runtime = new GraphRuntime();
    runtime.pushGraph(minimalGraph(), {});
    const scope = runtime.nextScope("start");
    runtime.enterNode("start", scope, { data: {}, source: { kind: "entry", entryId: "entry" } });

    expect(runtime.recordCompaction()).toBe(1);
    expect(runtime.recordCompaction()).toBe(2);
    expect(runtime.currentScope?.scopeId).toBe(scope.scopeId);
  });

  it("reset clears graph stack and transient node state", () => {
    const runtime = new GraphRuntime();
    runtime.pushGraph(minimalGraph(), {});
    runtime.enterNode("start", runtime.nextScope("start"), {
      data: {},
      source: { kind: "entry", entryId: "main" },
    });

    runtime.reset();

    expect(runtime.callStack).toEqual([]);
    expect(runtime.top).toBeNull();
    expect(runtime.isNodeActive).toBe(false);
    expect(runtime.currentNode).toBeNull();
    expect(runtime.currentInput).toBeNull();
    expect(runtime.currentScope).toBeNull();
  });
});
