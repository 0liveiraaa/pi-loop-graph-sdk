import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { defineGraph } from "../../src/builders/graph.js";
import { agentNode, codeNode, graphNode } from "../../src/builders/node.js";
import { connect, entry, finish, firstMatch } from "../../src/builders/route.js";
import { ContextState, materializeProjection, type ContextSnapshot } from "../../src/core/context.js";
import { graphRef } from "../../src/core/graph.js";
import { GraphCatalog } from "../../src/host/graph-catalog.js";
import { GraphRuntime } from "../../src/runtime/graph-runtime.js";

const Data = Type.Object({ visible: Type.String(), secret: Type.String() });
const Result = Type.Object({ ok: Type.Boolean() });

function snapshotText(snapshot: ContextSnapshot): string {
  return snapshot.layers.flatMap((layer) => typeof layer.content === "string"
    ? [layer.content]
    : layer.content.map((block) => block.type === "text" ? block.text : "[image]"))
    .join("\n");
}

function oneAgentGraph(context: any = { background: { select: "none" } }) {
  return defineGraph({
    id: "context-unit",
    version: "1",
    goal: "unit goal",
    input: Data,
    output: Result,
    context,
    entries: [entry("main", { to: "agent" })],
    stages: {
      agent: {
        node: agentNode({ subGoal: "unit node", input: Data, output: Result }),
        route: firstMatch({ done: finish({ output: () => ({ ok: true }) }) }),
      },
    },
  });
}

describe("Phase 4 Context State", () => {
  it("gives renderers only a frozen selected copy and never freezes the source", async () => {
    const source = { visible: { value: "yes" }, secret: "no" };
    let selectedView: unknown;
    const content = await materializeProjection(
      {
        select: (input) => ({ visible: input.visible }),
        render: ({ selected, meta }) => {
          selectedView = selected;
          expect(meta).toEqual({ label: "safe" });
          expect("source" in meta).toBe(false);
          return JSON.stringify(selected);
        },
      },
      source,
      { label: "safe" },
      () => null,
    );

    expect(content).toContain("yes");
    expect(content).not.toContain("no");
    expect(Object.isFrozen(selectedView)).toBe(true);
    expect(Object.isFrozen((selectedView as any).visible)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
  });

  it("materializes Background once, Focus per visit, and Memory once per Frame revision", async () => {
    const background = vi.fn((input: Readonly<{ visible: string; secret: string }>) => ({ visible: input.visible }));
    const memory = vi.fn((frames: readonly any[]) => ({ count: frames.length }));
    const focus = vi.fn((input: Readonly<{ visible: string; secret: string }>) => ({ visible: input.visible }));
    const graph = oneAgentGraph({
      background: { select: background, render: ({ selected }: any) => `GRAPH:${selected.visible}` },
      memory: { select: memory, render: ({ selected }: any) => `MEMORY:${selected.count}` },
    });
    const stage = {
      ...graph.stages.agent,
      node: { ...graph.stages.agent.node, context: { focus: { select: focus } } },
    } as any;
    const frames: any[] = [];
    const state = new ContextState({
      rootRunId: "root",
      graphInvocationId: "graph",
      graph,
      graphInput: { visible: "background", secret: "hidden" },
      graphSkills: [],
      frames,
    });

    await state.initialize();
    const first = await state.materializeNode("visit-1", "agent", stage, { visible: "one", secret: "s1" }, []);
    const second = await state.materializeNode("visit-2", "agent", stage, { visible: "two", secret: "s2" }, []);
    frames.push({ done: true });
    state.bumpMemoryRevision();
    const third = await state.materializeNode("visit-3", "agent", stage, { visible: "three", secret: "s3" }, []);

    expect(background).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(3);
    expect(memory).toHaveBeenCalledTimes(2);
    expect(snapshotText(first.snapshot)).toContain("GRAPH:background");
    expect(snapshotText(second.snapshot)).toContain("two");
    expect(snapshotText(third.snapshot)).toContain("MEMORY:1");
  });

  it("keeps custom Graph, Memory, and Node renderers in independent ordered layers", async () => {
    const graph = oneAgentGraph({
      background: { select: "none", render: () => "GRAPH_ONLY" },
      memory: { select: "all", render: () => "MEMORY_ONLY" },
    });
    const stage = {
      ...graph.stages.agent,
      node: { ...graph.stages.agent.node, context: { focus: { select: "none", render: () => "NODE_ONLY" } } },
    } as any;
    const state = new ContextState({
      rootRunId: "root",
      graphInvocationId: "graph",
      graph,
      graphInput: { visible: "v", secret: "s" },
      graphSkills: [],
      frames: [],
    });
    await state.initialize();
    const { snapshot } = await state.materializeNode("visit", "agent", stage, { visible: "v2", secret: "s2" }, []);

    expect(snapshot.layers.map((layer) => layer.name)).toEqual(["graph", "memory", "node"]);
    expect(snapshotText(snapshot)).toContain("GRAPH_ONLY");
    expect(snapshotText(snapshot)).toContain("MEMORY_ONLY");
    expect(snapshotText(snapshot)).toContain("NODE_ONLY");
  });

  it("preserves Graph Background when a later Node receives replacement input", async () => {
    const snapshots: ContextSnapshot[] = [];
    const graph = defineGraph({
      id: "replacement",
      version: "1",
      goal: "replace input",
      input: Data,
      output: Result,
      context: {
        background: {
          select: (input) => ({ visible: input.visible }),
          render: ({ selected }) => `BACKGROUND:${(selected as { visible: string } | null)?.visible}`,
        },
      },
      entries: [entry("main", { to: "first" })],
      stages: {
        first: {
          node: agentNode({ subGoal: "first", input: Data, output: Result }),
          route: firstMatch({ next: connect("second", { map: () => ({ visible: "replacement", secret: "later-secret" }) }) }),
        },
        second: {
          node: agentNode({ subGoal: "second", input: Data, output: Result }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const result = await new GraphRuntime({
      runAgent: async (_node, _input, context) => {
        snapshots.push(context.snapshot);
        return { ok: true };
      },
    }).execute(graph, { visible: "original", secret: "never-visible-in-background" });

    expect(result.status).toBe("completed");
    expect(snapshots).toHaveLength(2);
    expect(snapshotText(snapshots[1])).toContain("BACKGROUND:original");
    expect(snapshotText(snapshots[1])).toContain("replacement");
  });

  it("uses Agent Focus all, Code Focus none, and creates no Agent context for pure Code Nodes", async () => {
    const seen: ContextSnapshot[] = [];
    const hybrid = defineGraph({
      id: "code-focus",
      version: "1",
      goal: "code focus",
      input: Data,
      output: Result,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "code" })],
      stages: {
        code: {
          node: codeNode({
            subGoal: "code agent",
            input: Data,
            output: Result,
            async execute({ runAgent }) {
              return (await runAgent({ prompt: "work", output: Result })).result as { ok: boolean };
            },
          }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    await new GraphRuntime({
      runAgentFromCode: async (_request, _node, context) => {
        seen.push(context.snapshot);
        return { ok: true };
      },
    }).execute(hybrid, { visible: "visible", secret: "code-secret" });
    expect(snapshotText(seen[0])).not.toContain("code-secret");

    let agentCalls = 0;
    const pure = defineGraph({
      ...hybrid,
      id: "pure-code",
      stages: {
        code: {
          node: codeNode({ subGoal: "pure", input: Data, output: Result, execute: () => ({ ok: true }) }),
          route: hybrid.stages.code.route,
        },
      },
    });
    await new GraphRuntime({ runAgentFromCode: async () => { agentCalls += 1; return { ok: true }; } })
      .execute(pure, { visible: "v", secret: "s" });
    expect(agentCalls).toBe(0);
  });

  it("isolates recursive child Graph context and fails sticky budget before the Host Agent Run", async () => {
    const Scope = Type.Object({ scope: Type.String() });
    const child = defineGraph({
      id: "ctx-child", version: "1", goal: "child", input: Scope, output: Scope,
      context: { background: { select: "none", render: () => "CHILD_CONTEXT" } },
      entries: [entry("main", { to: "agent" })],
      stages: { agent: { node: agentNode({ subGoal: "child", input: Scope, output: Scope }), route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }) } },
    });
    const parent = defineGraph({
      id: "ctx-parent", version: "1", goal: "parent", input: Scope, output: Scope,
      context: { background: { select: "none", render: () => "PARENT_CONTEXT" } },
      entries: [entry("main", { to: "child" })],
      stages: {
        child: { node: graphNode({ subGoal: "child", input: Scope, output: Scope, graph: graphRef(child.id, child.version), boundary: "call" }), route: firstMatch({ next: connect("parent-agent") }) },
        "parent-agent": { node: agentNode({ subGoal: "parent", input: Scope, output: Scope }), route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }) },
      },
    });
    const catalog = new GraphCatalog();
    catalog.register(child);
    const snapshots: ContextSnapshot[] = [];
    const result = await new GraphRuntime({
      catalog,
      runAgent: async (_node, input, context) => { snapshots.push(context.snapshot); return input; },
    }).execute(parent, { scope: "root" });
    expect(result.status).toBe("completed");
    expect(snapshotText(snapshots[0])).toContain("CHILD_CONTEXT");
    expect(snapshotText(snapshots[0])).not.toContain("PARENT_CONTEXT");
    expect(snapshotText(snapshots[1])).toContain("PARENT_CONTEXT");
    expect(snapshotText(snapshots[1])).not.toContain("CHILD_CONTEXT");

    let hostCalls = 0;
    const budgetResult = await new GraphRuntime({
      maxStickyContextBytes: 16,
      runAgent: async () => { hostCalls += 1; return { ok: true }; },
    }).execute(oneAgentGraph({ background: { select: "all" } }), { visible: "large-value", secret: "large-secret" });
    expect(budgetResult).toMatchObject({ status: "failed", failure: { phase: "agent", retryable: false } });
    expect(budgetResult.status === "failed" && budgetResult.failure.message).toContain("Sticky context budget exceeded");
    expect(hostCalls).toBe(0);
  });
});
