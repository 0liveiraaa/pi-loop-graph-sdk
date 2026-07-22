import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineGraph } from "../../src/builders/graph.js";
import { agentNode, codeNode, graphNode } from "../../src/builders/node.js";
import { connect, entry, finish, firstMatch } from "../../src/builders/route.js";
import { graphRef } from "../../src/core/graph.js";
import type { GraphRunResult } from "../../src/core/result.js";
import { GraphCatalog } from "../../src/host/graph-catalog.js";
import { RuntimeEventBus, type RuntimeEvent } from "../../src/runtime/event-bus.js";
import { GraphRuntime, type AgentExecutionContext } from "../../src/runtime/graph-runtime.js";

const Counter = Type.Object({ remaining: Type.Number(), value: Type.Number() });
const Value = Type.Object({ value: Type.Number() });
const InspectedValue = Type.Object({ value: Type.Number(), frameCount: Type.Number() });

function recursiveGraph(id: string, target = id) {
  const base = codeNode({
    subGoal: "base",
    input: Counter,
    output: Value,
    execute: ({ input, complete }) => complete({ value: input.value }),
  });
  return defineGraph({
    id,
    version: "1",
    goal: `recursive ${id}`,
    input: Counter,
    output: Value,
    context: { background: { select: "none" } },
    entries: [
      entry<{ remaining: number; value: number }>("recurse", {
        to: "recurse",
        guard: (input) => input.remaining > 0,
        mapInput: (input) => ({ remaining: input.remaining - 1, value: input.value }),
      }),
      entry<{ remaining: number; value: number }>("base", { to: "base" }),
    ],
    stages: {
      recurse: {
        node: graphNode({
          subGoal: "recursive call",
          input: Counter,
          output: Value,
          graph: graphRef(target, "1"),
          boundary: "call",
        }),
        route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
      },
      base: {
        node: base,
        route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
      },
    },
  });
}

function childGraph(id = "child") {
  const increment = codeNode({
    subGoal: "increment",
    input: Value,
    output: Value,
    execute: ({ input, complete }) => complete({ value: input.value + 1 }),
  });
  return defineGraph({
    id,
    version: "1",
    goal: "increment child",
    input: Value,
    output: Value,
    context: { background: { select: "none" } },
    entries: [entry("main", { to: "increment" })],
    stages: {
      increment: {
        node: increment,
        route: firstMatch({
          done: finish({
            frame: ({ completion }) => ({ childValue: completion.result.value }),
            output: ({ completion }) => completion.result,
          }),
        }),
      },
    },
  });
}

function parentGraph(boundary: "call" | "compose" | "delegate", childId = "child") {
  return defineGraph({
    id: `parent-${boundary}`,
    version: "1",
    goal: `${boundary} child`,
    input: Value,
    output: Value,
    context: { background: { select: "none" } },
    entries: [entry("main", { to: "child" })],
    stages: {
      child: {
        node: graphNode({
          subGoal: "child",
          input: Value,
          output: Value,
          graph: graphRef(childId, "1"),
          boundary,
        }),
        route: firstMatch({
          done: finish({
            frame: ({ completion }) => ({ parentValue: completion.result.value }),
            output: ({ completion }) => completion.result,
          }),
        }),
      },
    },
  });
}

describe("Phase 2 GraphRuntime identity and invocation lineage", () => {
  it("shares one rootRunId across direct recursion and creates unique invocation/visit IDs", async () => {
    const graph = recursiveGraph("self");
    const catalog = new GraphCatalog();
    catalog.register(graph);
    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));

    const result = await new GraphRuntime({ catalog, eventBus }).execute(graph, {
      remaining: 3,
      value: 7,
    });

    expect(result).toMatchObject({ status: "completed", output: { value: 7 }, steps: 4 });
    const graphEvents = events.filter((event) => event.type === "graph_entered");
    const nodeEvents = events.filter((event) => event.type === "node_entered");
    expect(new Set(events.map((event) => event.rootRunId))).toEqual(new Set([result.rootRunId]));
    expect(new Set(graphEvents.map((event) => event.graphInvocationId)).size).toBe(4);
    expect(new Set(nodeEvents.map((event) => event.nodeVisitId)).size).toBe(4);
    expect(graphEvents.map((event) => event.depth)).toEqual([1, 2, 3, 4]);
    expect(graphEvents[0].parentGraphInvocationId).toBeUndefined();
    expect(graphEvents.slice(1).every((event, index) =>
      event.parentGraphInvocationId === graphEvents[index].graphInvocationId
    )).toBe(true);
  });

  it("supports indirect recursion through the same Graph Catalog", async () => {
    const a = recursiveGraph("a", "b");
    const b = recursiveGraph("b", "a");
    const catalog = new GraphCatalog();
    catalog.register(a);
    catalog.register(b);

    await expect(new GraphRuntime({ catalog }).execute(a, {
      remaining: 4,
      value: 9,
    })).resolves.toMatchObject({
      status: "completed",
      output: { value: 9 },
      steps: 5,
    });
  });

  it("creates a new NodeVisit ID on every loop revisit", async () => {
    const decrement = codeNode({
      subGoal: "decrement",
      input: Counter,
      output: Counter,
      execute: ({ input, complete }) => complete({ ...input, remaining: input.remaining - 1 }),
    });
    const graph = defineGraph({
      id: "loop-visits",
      version: "1",
      goal: "loop",
      input: Counter,
      output: Counter,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "loop" })],
      stages: {
        loop: {
          node: decrement,
          route: firstMatch({
            repeat: connect("loop", {
              guard: (result) => result.remaining > 0,
              map: ({ completion }) => completion.result,
            }),
            done: finish({ output: ({ completion }) => completion.result }),
          }),
        },
      },
    });
    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));
    const result = await new GraphRuntime({ eventBus }).execute(graph, { remaining: 3, value: 1 });
    const visits = events.filter((event) => event.type === "node_entered");

    expect(result.steps).toBe(3);
    expect(visits.map((event) => event.visit)).toEqual([1, 2, 3]);
    expect(new Set(visits.map((event) => event.nodeVisitId)).size).toBe(3);
  });

  it("creates a distinct AgentRun state for multiple runs in one Node Visit", async () => {
    const hybrid = codeNode({
      subGoal: "two agent runs",
      input: Value,
      output: Value,
      async execute({ input, runAgent, complete }) {
        await runAgent({ prompt: String(input.value + 1) });
        const second = await runAgent({ prompt: String(input.value + 2) });
        return complete(second.result as { value: number });
      },
    });
    const graph = defineGraph({
      id: "agent-identities",
      version: "1",
      goal: "agent identities",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "hybrid" })],
      stages: {
        hybrid: {
          node: hybrid,
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const contexts: AgentExecutionContext[] = [];
    const runtime = new GraphRuntime({
      async runAgentFromCode(request, _node, context) {
        contexts.push(context);
        return { value: Number(request.prompt) };
      },
    });

    const result = await runtime.execute(graph, { value: 1 });
    expect(result).toMatchObject({ status: "completed", output: { value: 3 } });
    expect(contexts.map((context) => context.agentRun.index)).toEqual([1, 2]);
    expect(new Set(contexts.map((context) => context.agentRun.agentRunId)).size).toBe(2);
    expect(new Set(contexts.map((context) => context.nodeVisit.nodeVisitId)).size).toBe(1);
  });

  it("keeps agent-triggered graph calls in the active root lineage", async () => {
    const child = childGraph("agent-child");
    const agentRoot = defineGraph({
      id: "agent-root",
      version: "1",
      goal: "agent graph tool",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "agent" })],
      stages: {
        agent: {
          node: agentNode({ subGoal: "invoke child", input: Value, output: Value }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const catalog = new GraphCatalog();
    catalog.register(child);
    catalog.register(agentRoot);
    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));
    const runtime = new GraphRuntime({
      catalog,
      eventBus,
      async runAgent(_node, input, context) {
        const childResult = await context.invokeGraph(graphRef("agent-child", "1"), input);
        if (childResult.status !== "completed") throw new Error("child failed");
        return childResult.output!;
      },
    });

    const result = await runtime.execute(agentRoot, { value: 1 });
    expect(result).toMatchObject({ status: "completed", output: { value: 2 }, steps: 2 });
    const invocations = events.filter((event) => event.type === "graph_entered");
    expect(invocations).toHaveLength(2);
    expect(invocations[1].parentGraphInvocationId).toBe(invocations[0].graphInvocationId);
    expect(invocations.every((event) => event.rootRunId === result.rootRunId)).toBe(true);
  });
});

describe("Phase 2 boundaries and shared budget", () => {
  it.each(["call", "compose", "delegate"] as const)("%s uses the same child Graph semantics", async (boundary) => {
    const child = childGraph();
    const parent = parentGraph(boundary);
    const catalog = new GraphCatalog();
    catalog.register(child);
    catalog.register(parent);
    let delegatedRootId: string | undefined;
    const runtime = new GraphRuntime({
      catalog,
      delegateGraph: boundary === "delegate"
        ? async (request) => {
            delegatedRootId = request.root.rootRunId;
            return request.execute();
          }
        : undefined,
    });

    const result = await runtime.execute(parent, { value: 1 });
    expect(result).toMatchObject({ status: "completed", output: { value: 2 }, steps: 2 });
    if (boundary === "delegate") expect(delegatedRootId).toBe(result.rootRunId);
  });

  it("fails delegate before entering the child when no Delegate Host exists", async () => {
    const child = childGraph();
    const parent = parentGraph("delegate");
    const catalog = new GraphCatalog();
    catalog.register(child);
    catalog.register(parent);
    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));

    await expect(new GraphRuntime({ catalog, eventBus }).execute(parent, { value: 1 })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "host-unavailable", phase: "host" },
      steps: 1,
    });
    expect(events.filter((event) => event.type === "graph_entered")).toHaveLength(1);
  });

  it.each([
    ["call", 0],
    ["compose", 1],
    ["delegate", 0],
  ] as const)("%s shares only the documented Memory boundary", async (boundary, expectedFrameCount) => {
    const child = childGraph("memory-child");
    const inspect = agentNode({
      subGoal: "inspect memory",
      input: Value,
      output: InspectedValue,
    });
    const parent = defineGraph({
      id: `memory-parent-${boundary}`,
      version: "1",
      goal: "inspect child memory",
      input: Value,
      output: InspectedValue,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "child" })],
      stages: {
        child: {
          node: graphNode({
            subGoal: "child",
            input: Value,
            output: Value,
            graph: graphRef("memory-child", "1"),
            boundary,
          }),
          route: firstMatch({ inspect: connect("inspect", { map: ({ completion }) => completion.result }) }),
        },
        inspect: {
          node: inspect,
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const catalog = new GraphCatalog();
    catalog.register(child);
    catalog.register(parent);
    const runtime = new GraphRuntime({
      catalog,
      delegateGraph: boundary === "delegate" ? (request) => request.execute() : undefined,
      async runAgent(_node, input, context) {
        return { value: (input as { value: number }).value, frameCount: context.invocation.frames.length };
      },
    });

    await expect(runtime.execute(parent, { value: 1 })).resolves.toMatchObject({
      status: "completed",
      output: { value: 2, frameCount: expectedFrameCount },
    });
  });

  it("fails recursive calls at the shared depth limit", async () => {
    const graph = recursiveGraph("limited");
    const catalog = new GraphCatalog();
    catalog.register(graph);

    const result = await new GraphRuntime({ catalog }).execute(
      graph,
      { remaining: 5, value: 1 },
      { limits: { maxGraphDepth: 3 } },
    );
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "max-steps-exceeded", phase: "root", retryable: false },
      steps: 3,
    });
  });

  it.each([
    ["maxGraphInvocations", { maxGraphInvocations: 2 }],
    ["maxTotalNodeVisits", { maxTotalNodeVisits: 2 }],
  ] as const)("enforces shared %s limits", async (_name, limits) => {
    const graph = recursiveGraph(`limited-${_name}`);
    const catalog = new GraphCatalog();
    catalog.register(graph);
    const result = await new GraphRuntime({ catalog }).execute(
      graph,
      { remaining: 5, value: 1 },
      { limits },
    );
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "max-steps-exceeded", retryable: false },
      steps: 2,
    });
  });

  it("shares invocation and node-visit usage across delegate execution", async () => {
    const child = childGraph();
    const parent = parentGraph("delegate");
    const catalog = new GraphCatalog();
    catalog.register(child);
    catalog.register(parent);
    let usageBefore: { graphInvocations: number; nodeVisits: number } | undefined;
    let usageAfter: { graphInvocations: number; nodeVisits: number } | undefined;
    const runtime = new GraphRuntime({
      catalog,
      async delegateGraph(request) {
        usageBefore = request.root.budget.usage;
        const result = await request.execute();
        usageAfter = request.root.budget.usage;
        return result;
      },
    });

    await runtime.execute(parent, { value: 1 });
    expect(usageBefore).toMatchObject({ graphInvocations: 1, nodeVisits: 1 });
    expect(usageAfter).toMatchObject({ graphInvocations: 2, nodeVisits: 2 });
  });
});

describe("Phase 2 structured results and events", () => {
  it("returns stable failures for unresolved GraphRef, no route, and cancellation", async () => {
    const missing = parentGraph("call", "missing");
    const missingResult = await new GraphRuntime().execute(missing, { value: 1 });
    expect(missingResult).toMatchObject({
      status: "failed",
      failure: { code: "invalid-graph", phase: "graph", retryable: false },
    });

    const noRoute = defineGraph({
      id: "no-route",
      version: "1",
      goal: "no route",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "node" })],
      stages: {
        node: {
          node: codeNode({
            subGoal: "done",
            input: Value,
            output: Value,
            execute: ({ input, complete }) => complete(input),
          }),
          route: { kind: "first-match", connections: [] },
        },
      },
    });
    await expect(new GraphRuntime().execute(noRoute, { value: 1 })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "no-route", phase: "route", stageId: "node" },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(new GraphRuntime().execute(childGraph("cancelled"), { value: 1 }, {
      signal: controller.signal,
    })).resolves.toMatchObject({
      status: "cancelled",
      failure: { code: "cancelled" },
      steps: 0,
    });
  });

  it("does not create a Graph Invocation for invalid Graph input", async () => {
    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));
    const result = await new GraphRuntime({ eventBus }).execute(childGraph("invalid-input"), { value: "bad" } as never);

    expect(result).toMatchObject({ status: "failed", steps: 0, failure: { code: "invalid-input" } });
    expect(events.map((event) => event.type)).toEqual([
      "root_started",
      "host_baseline_selected",
      "mechanism_scope_opened",
      "mechanism_scope_closed",
      "root_finished",
    ]);
  });

  it("maps active Host cancellation to cancelled and closes every entered lifecycle", async () => {
    const graph = defineGraph({
      id: "active-cancellation",
      version: "1",
      goal: "cancel an active Agent run",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "agent" })],
      stages: {
        agent: {
          node: agentNode({ subGoal: "wait", input: Value, output: Value }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const runtime = new GraphRuntime({
      eventBus,
      async runAgent(_node, _input, context) {
        notifyStarted();
        return await new Promise((_, reject) => {
          const abort = () => {
            const error = new Error("host operation aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (context.root.signal?.aborted) abort();
          else context.root.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });

    const running = runtime.execute(graph, { value: 1 }, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(running).resolves.toMatchObject({
      status: "cancelled",
      failure: { code: "cancelled", phase: "root" },
      steps: 1,
    });

    expect(events.filter((event) => event.type === "node_entered")).toHaveLength(1);
    expect(events.filter((event) => event.type === "node_exited")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_finished")).toHaveLength(1);
    expect(events.find((event) => event.type === "graph_exited")).toMatchObject({ status: "cancelled" });
    expect(events.at(-1)).toMatchObject({ type: "root_finished", status: "cancelled" });
  });

  it("preserves cancelled child semantics when a Delegate Host omits a failure payload", async () => {
    const child = childGraph("cancelled-child");
    const parent = parentGraph("delegate", "cancelled-child");
    const catalog = new GraphCatalog();
    catalog.register(child);
    catalog.register(parent);

    await expect(new GraphRuntime({
      catalog,
      delegateGraph: async () => ({ status: "cancelled" }),
    }).execute(parent, { value: 1 })).resolves.toMatchObject({
      status: "cancelled",
      failure: { code: "cancelled" },
      steps: 1,
    });
  });

  it("emits synchronous immutable facts without observer failures changing control flow", async () => {
    const eventBus = new RuntimeEventBus();
    const events: RuntimeEvent[] = [];
    eventBus.subscribe((event) => {
      events.push(event);
      expect(Object.isFrozen(event)).toBe(true);
    });
    eventBus.subscribe(() => { throw new Error("observer failure"); });

    const result = await new GraphRuntime({ eventBus }).execute(childGraph("events"), { value: 1 });
    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "root_started",
      "host_baseline_selected",
      "mechanism_scope_opened",
      "graph_entered",
      "mechanism_scope_opened",
      "node_entered",
      "mechanism_scope_opened",
      "context_snapshot_materialized",
      "mechanism_scope_closed",
      "transition_selected",
      "node_exited",
      "graph_exited",
      "mechanism_scope_closed",
      "mechanism_scope_closed",
      "root_finished",
    ]);
  });
});

function exhaustResult(result: GraphRunResult<{ value: number }>): number {
  switch (result.status) {
    case "completed": return result.output.value;
    case "failed": return result.failure.retryable ? 1 : 0;
    case "cancelled": return -1;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

void exhaustResult;
