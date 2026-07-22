import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { defineGraph } from "../../src/builders/graph.js";
import { agentNode, graphNode } from "../../src/builders/node.js";
import { entry, finish, firstMatch } from "../../src/builders/route.js";
import { graphRef } from "../../src/core/graph.js";
import { GraphCatalog } from "../../src/host/graph-catalog.js";
import { GraphRuntime, type InvocationAgentHostRequest } from "../../src/runtime/graph-runtime.js";

const Value = Type.Object({ value: Type.Number() });

function agentGraph(id: string) {
  return defineGraph({
    id, version: "1", goal: id, input: Value, output: Value,
    context: { background: { select: "none" } },
    entries: [entry("main", { to: "agent" })],
    stages: {
      agent: {
        node: agentNode({ subGoal: id, input: Value, output: Value }),
        route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
      },
    },
  });
}

function parent(boundary: "call" | "compose" | "delegate", childId: string) {
  return defineGraph({
    id: `parent-${boundary}`, version: "1", goal: boundary, input: Value, output: Value,
    context: { background: { select: "none" } },
    entries: [entry("main", { to: "child" })],
    stages: {
      child: {
        node: graphNode({ subGoal: "child", input: Value, output: Value, graph: graphRef(childId, "1"), boundary }),
        route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
      },
    },
  });
}

describe("Phase 7.1 invocation-scoped Agent Host", () => {
  it.each(["call", "compose"] as const)("creates one isolated Agent lane for a %s child and disposes it", async (boundary) => {
    const child = agentGraph(`child-${boundary}`);
    const root = parent(boundary, child.id);
    const catalog = new GraphCatalog(); catalog.register(root); catalog.register(child);
    const created: InvocationAgentHostRequest[] = [];
    const dispose = vi.fn();
    const rootAgent = vi.fn();
    const childAgent = vi.fn(async (_node, input) => ({ value: (input as { value: number }).value + 1 }));
    const runtime = new GraphRuntime({
      catalog,
      runAgent: rootAgent,
      async createInvocationAgentHost(request) {
        created.push(request);
        return { runAgent: childAgent, dispose };
      },
    });

    await expect(runtime.execute(root, { value: 1 })).resolves.toMatchObject({ status: "completed", output: { value: 2 }, steps: 2 });
    expect(created).toHaveLength(1);
    expect(created[0].invocation).toMatchObject({ boundary, depth: 2, graph: { id: child.id } });
    expect(created[0].root.rootRunId).toBe(created[0].invocation.rootRunId);
    expect(childAgent).toHaveBeenCalledOnce();
    expect(rootAgent).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("creates and disposes an isolated Agent lane for delegate boundaries", async () => {
    const child = agentGraph("delegate-child");
    const root = parent("delegate", child.id);
    const catalog = new GraphCatalog(); catalog.register(root); catalog.register(child);
    const dispose = vi.fn();
    const delegateAgent = vi.fn(async (_node, input) => input as { value: number });
    const factory = vi.fn(async (_request: InvocationAgentHostRequest) => ({ runAgent: delegateAgent, dispose }));
    const rootAgent = vi.fn(async (_node, input) => input as { value: number });
    const runtime = new GraphRuntime({ catalog, runAgent: rootAgent, createInvocationAgentHost: factory, delegateGraph: (request) => request.execute() });
    await expect(runtime.execute(root, { value: 3 })).resolves.toMatchObject({ status: "completed", output: { value: 3 } });
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0].invocation).toMatchObject({ boundary: "delegate", depth: 2 });
    expect(delegateAgent).toHaveBeenCalledOnce();
    expect(rootAgent).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("creates a distinct lane for every recursive call invocation and disposes all lanes", async () => {
    const recursive = defineGraph({
      ...agentGraph("recursive-lanes"),
      entries: [
        entry<{ value: number }>("recurse", { to: "child", guard: (input) => input.value > 0 }),
        entry<{ value: number }>("base", { to: "agent" }),
      ],
      stages: {
        ...agentGraph("recursive-lanes").stages,
        child: {
          node: graphNode({ subGoal: "recurse", input: Value, output: Value, graph: graphRef("recursive-lanes", "1"), boundary: "call" }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const catalog = new GraphCatalog(); catalog.register(recursive);
    const ids: string[] = []; const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const runtime = new GraphRuntime({
      catalog,
      runAgent: async () => ({ value: 0 }),
      async createInvocationAgentHost(request) {
        ids.push(request.invocation.graphInvocationId);
        const dispose = vi.fn(); disposers.push(dispose);
        return { runAgent: async () => ({ value: 0 }), dispose };
      },
    });
    // Budget termination proves recursive invocations still share the Root budget.
    await expect(runtime.execute(recursive, { value: 1 }, { limits: { maxGraphDepth: 4 } })).resolves.toMatchObject({ status: "failed", failure: { code: "max-steps-exceeded" } });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1);
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it("disposes the child lane when Agent execution fails", async () => {
    const child = agentGraph("failing-child"); const root = parent("call", child.id);
    const catalog = new GraphCatalog(); catalog.register(root); catalog.register(child);
    const dispose = vi.fn();
    const runtime = new GraphRuntime({ catalog, async createInvocationAgentHost() { return { runAgent: async () => { throw new Error("boom"); }, dispose }; } });
    await expect(runtime.execute(root, { value: 1 })).resolves.toMatchObject({ status: "failed" });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
