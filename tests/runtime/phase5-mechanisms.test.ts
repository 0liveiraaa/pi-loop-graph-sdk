import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { defineGraph } from "../../src/builders/graph.js";
import { agentNode, graphNode } from "../../src/builders/node.js";
import { connect, entry, finish, firstMatch } from "../../src/builders/route.js";
import { defineMechanism, type Mechanism } from "../../src/core/mechanism.js";
import { graphRef } from "../../src/core/graph.js";
import { GraphCatalog } from "../../src/host/graph-catalog.js";
import { RuntimeEventBus } from "../../src/runtime/event-bus.js";
import { GraphRuntime } from "../../src/runtime/graph-runtime.js";
import { MechanismRuntime } from "../../src/runtime/mechanism-runtime.js";

const Value = Type.Object({ value: Type.Number() });

function singleAgent(mechanisms: readonly Mechanism[] = [], graphMechanisms: readonly Mechanism[] = []) {
  return defineGraph({
    id: "phase5-agent", version: "1", goal: "mechanisms", input: Value, output: Value,
    context: { background: { select: "none" } }, mechanisms: graphMechanisms,
    entries: [entry("main", { to: "agent" })],
    stages: {
      agent: {
        node: agentNode({ subGoal: "run", input: Value, output: Value, mechanisms }),
        route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
      },
    },
  });
}

describe("Phase 5 three-layer Mechanism Runtime", () => {
  it("runs enter/agent hooks Host -> Graph -> Node and exit hooks Node -> Graph -> Host", async () => {
    const order: string[] = [];
    const mechanism = (name: string) => defineMechanism({
      name,
      onRootEnter: () => { order.push(`${name}:root-enter`); },
      onGraphEnter: () => { order.push(`${name}:graph-enter`); },
      onNodeEnter: () => { order.push(`${name}:node-enter`); },
      beforeAgentRun: () => { order.push(`${name}:before`); },
      afterAgentRun: () => { order.push(`${name}:after`); },
      onNodeExit: () => { order.push(`${name}:node-exit`); },
      onGraphExit: () => { order.push(`${name}:graph-exit`); },
      onRootExit: () => { order.push(`${name}:root-exit`); },
    });
    const host = mechanism("host"); const graph = mechanism("graph"); const node = mechanism("node");
    const result = await new GraphRuntime({
      mechanisms: [host],
      runAgent: async (_node, input) => input,
    }).execute(singleAgent([node], [graph]), { value: 1 });

    expect(result.status).toBe("completed");
    expect(order).toEqual([
      "host:root-enter",
      "host:graph-enter", "graph:graph-enter",
      "host:node-enter", "graph:node-enter", "node:node-enter",
      "host:before", "graph:before", "node:before",
      "node:after", "graph:after", "host:after",
      "node:node-exit", "graph:node-exit", "host:node-exit",
      "graph:graph-exit", "host:graph-exit",
      "host:root-exit",
    ]);
  });

  it("keeps Host state for Root, Graph state for Invocation, and Node state for one Visit with multiple Agent Runs", async () => {
    const states = { host: 0, graph: 0, node: 0 };
    const create = (name: keyof typeof states) => defineMechanism({
      name,
      createState: () => { states[name] += 1; return { runs: 0 }; },
      beforeAgentRun(ctx) { ctx.state.runs += 1; },
    });
    const codeLikeAgent = singleAgent([create("node")], [create("graph")]);
    await new GraphRuntime({ mechanisms: [create("host")], runAgent: async (_node, input) => input })
      .execute(codeLikeAgent, { value: 1 });
    expect(states).toEqual({ host: 1, graph: 1, node: 1 });
  });

  it("does not inherit parent Graph Mechanisms into compose children", async () => {
    const seen: string[] = [];
    const parentMechanism = defineMechanism({ name: "parent-only", onNodeEnter: () => { seen.push("parent"); } });
    const childMechanism = defineMechanism({ name: "child-only", onNodeEnter: () => { seen.push("child"); } });
    const child = { ...singleAgent([], [childMechanism]), id: "phase5-child" } as any;
    const parent = defineGraph({
      id: "phase5-parent", version: "1", goal: "parent", input: Value, output: Value,
      context: { background: { select: "none" } }, mechanisms: [parentMechanism],
      entries: [entry("main", { to: "child" })],
      stages: {
        child: {
          node: graphNode({ subGoal: "child", input: Value, output: Value, graph: graphRef(child.id, child.version), boundary: "compose" }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const catalog = new GraphCatalog(); catalog.register(child);
    await new GraphRuntime({ catalog, runAgent: async (_node, input) => input }).execute(parent, { value: 1 });
    expect(seen).toEqual(["parent", "child"]);
  });

  it("rejects duplicate identities unless allowMultiple is explicit", async () => {
    const duplicate = defineMechanism({ name: "duplicate" });
    const result = await new GraphRuntime({
      mechanisms: [duplicate],
      runAgent: async (_node, input) => input,
    }).execute(singleAgent([], [duplicate]), { value: 1 });
    expect(result).toMatchObject({ status: "failed", failure: { code: "mechanism-failed" } });

    const multiple = defineMechanism({ name: "multiple", allowMultiple: true });
    await expect(new GraphRuntime({ mechanisms: [multiple], runAgent: async (_node, input) => input })
      .execute(singleAgent([], [multiple]), { value: 1 })).resolves.toMatchObject({ status: "completed" });
  });

  it("projects managed contributions, enforces maximum lifetime, and disposes them with scope", async () => {
    const snapshots: string[] = [];
    const contribution = defineMechanism({
      name: "context-writer",
      onNodeEnter(ctx) {
        const handle = ctx.context.add("rule", "NODE RULE");
        handle.update("UPDATED NODE RULE");
        expect(() => ctx.context.add("too-long", "bad", { lifetime: "root-run" })).toThrow(/cannot create root-run/);
      },
      beforeAgentRun(ctx) { ctx.context.add("run", "RUN ONLY"); },
    });
    await new GraphRuntime({
      runAgent: async (_node, input, context) => {
        snapshots.push(JSON.stringify(context.snapshot));
        return input;
      },
    }).execute(singleAgent([contribution]), { value: 1 });
    expect(snapshots[0]).toContain("UPDATED NODE RULE");
    expect(snapshots[0]).toContain("RUN ONLY");
  });

  it("records observation failures but fails closed for control failures and timeouts", async () => {
    const observation = defineMechanism({ name: "observe", onNodeEnter: () => { throw new Error("observe failed"); } });
    await expect(new GraphRuntime({ runAgent: async (_node, input) => input })
      .execute(singleAgent([observation]), { value: 1 })).resolves.toMatchObject({ status: "completed" });

    let calls = 0;
    const control = defineMechanism({ name: "control", beforeAgentRun: () => { throw new Error("blocked"); } });
    const failed = await new GraphRuntime({ runAgent: async (_node, input) => { calls += 1; return input; } })
      .execute(singleAgent([control]), { value: 1 });
    expect(failed).toMatchObject({ status: "failed", failure: { code: "mechanism-failed", retryable: false } });
    expect(calls).toBe(0);

    const timeout = defineMechanism({ name: "timeout", beforeAgentRun: () => new Promise(() => undefined) });
    await expect(new GraphRuntime({ mechanismRuntime: { hookTimeoutMs: 5 }, runAgent: async (_node, input) => input })
      .execute(singleAgent([timeout]), { value: 1 })).resolves.toMatchObject({ status: "failed", failure: { code: "mechanism-failed" } });
  });

  it("runs cleanup in LIFO order, validates JSON state/snapshots, and sandboxes exec", async () => {
    const cleanup: string[] = [];
    const runtime = new MechanismRuntime({ execRoot: process.cwd(), execMaxOutputBytes: 4 });
    const mechanism = defineMechanism({
      name: "direct",
      createState: () => ({ ok: true }),
      snapshot: (state) => state,
      restore: (snapshot) => snapshot as { ok: true },
      onNodeEnter(ctx) {
        ctx.scope.onCleanup(() => { cleanup.push("first"); });
        ctx.scope.onCleanup(() => { cleanup.push("second"); });
      },
    });
    const chain = await runtime.open("node", "visit", [mechanism], { rootRunId: "root", graphInvocationId: "graph", nodeVisitId: "visit" });
    await runtime.enter([chain], "onNodeEnter");
    await runtime.close(chain);
    expect(cleanup).toEqual(["second", "first"]);

    const bad = defineMechanism({ name: "bad-state", createState: () => new Date() as never });
    await expect(runtime.open("node", "bad", [bad], { rootRunId: "root" })).rejects.toThrow(/JSON-compatible/);
    await expect(chain.invocations[0].context.exec.run(process.execPath, ["-e", "process.stdout.write('123456')"])).resolves.toMatchObject({ stdout: "1234", truncated: true });
    await expect(chain.invocations[0].context.exec.run(process.execPath, [], { cwd: ".." })).rejects.toThrow(/outside execRoot/);
  });

  it("marks ctx.pi access as unmanaged and emits one warning", async () => {
    const eventBus = new RuntimeEventBus();
    const warnings: string[] = [];
    eventBus.subscribe((event) => { if (event.type === "runtime_warning") warnings.push(event.code); });
    const mechanism = defineMechanism({ name: "unsafe", onNodeEnter(ctx) { void ctx.pi; void ctx.pi; } });
    await new GraphRuntime({
      eventBus,
      mechanismRuntime: { pi: { unsafe: true } },
      runAgent: async (_node, input) => input,
    }).execute(singleAgent([mechanism]), { value: 1 });
    expect(warnings.filter((code) => code === "unmanaged-mechanism-access")).toHaveLength(1);
  });
});
