import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineGraph, defineSingleAgentGraph } from "../../src/builders/graph.js";
import { agentNode, graphNode } from "../../src/builders/node.js";
import { skillRef, toolSet } from "../../src/builders/refs.js";
import { entry, finish, firstMatch } from "../../src/builders/route.js";
import { graphRef } from "../../src/core/graph.js";
import { GraphCatalog } from "../../src/host/graph-catalog.js";
import { SkillCatalog } from "../../src/host/skill-catalog.js";
import { ToolCatalog } from "../../src/host/tool-catalog.js";
import { RuntimeEventBus, type RuntimeEvent } from "../../src/runtime/event-bus.js";
import { GraphRuntime, type AgentExecutionContext } from "../../src/runtime/graph-runtime.js";

const Value = Type.Object({ value: Type.Number() });

function singleAgent(options: {
  id: string;
  graphTools?: readonly string[];
  nodeTools?: readonly string[] | "all";
  graphSkills?: ReturnType<typeof skillRef>[];
  nodeSkills?: ReturnType<typeof skillRef>[];
}) {
  return defineSingleAgentGraph({
    id: options.id,
    version: "1",
    goal: options.id,
    input: Value,
    output: Value,
    tools: options.graphTools,
    skills: options.graphSkills,
    context: { background: { select: "none" } },
    node: agentNode({
      subGoal: options.id,
      input: Value,
      output: Value,
      tools: options.nodeTools,
      skills: options.nodeSkills,
    }),
  });
}

describe("Phase 3 Tool Policy", () => {
  it("requires Host implementation, Graph authorization, and Node selection", async () => {
    const tools = new ToolCatalog();
    tools.register({ name: "read" });
    const seen: string[][] = [];
    const run = (graph: ReturnType<typeof singleAgent>) => new GraphRuntime({
      toolCatalog: tools,
      async runAgent(_node, input, context) {
        seen.push(context.tools.map((tool) => tool.name));
        return input;
      },
    }).execute(graph, { value: 1 });

    await run(singleAgent({ id: "none" }));
    await run(singleAgent({ id: "graph-only", graphTools: toolSet("read") }));
    await run(singleAgent({ id: "selected", graphTools: toolSet("read"), nodeTools: toolSet("read") }));
    await run(singleAgent({ id: "all", graphTools: toolSet("read"), nodeTools: "all" }));

    expect(seen).toEqual([
      ["__graph_complete__"],
      ["__graph_complete__"],
      ["read", "__graph_complete__"],
      ["read", "__graph_complete__"],
    ]);
  });

  it("fails before execution when Graph dependencies are absent or Node exceeds policy", async () => {
    const missing = await new GraphRuntime({
      toolCatalog: new ToolCatalog(),
      runAgent: async (_node, input) => input,
    }).execute(singleAgent({ id: "missing", graphTools: toolSet("read"), nodeTools: "all" }), { value: 1 });
    expect(missing).toMatchObject({ status: "failed", failure: { code: "tool-unavailable", phase: "host" } });

    const tools = new ToolCatalog();
    tools.register({ name: "read" });
    const outside = await new GraphRuntime({
      toolCatalog: tools,
      runAgent: async (_node, input) => input,
    }).execute(singleAgent({ id: "outside", nodeTools: toolSet("read") }), { value: 1 });
    expect(outside).toMatchObject({ status: "failed", failure: { code: "invalid-graph", phase: "graph" } });
  });

  it("lets a child Graph declare its own tools without repeating them in the parent", async () => {
    const child = singleAgent({ id: "tool-child", graphTools: toolSet("read"), nodeTools: "all" });
    const parent = defineGraph({
      id: "tool-parent",
      version: "1",
      goal: "parent",
      input: Value,
      output: Value,
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "child" })],
      stages: {
        child: {
          node: graphNode({ subGoal: "child", input: Value, output: Value, graph: graphRef("tool-child", "1") }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const graphs = new GraphCatalog();
    graphs.register(child);
    graphs.register(parent);
    const tools = new ToolCatalog();
    tools.register({ name: "read" });
    let childTools: string[] = [];
    const result = await new GraphRuntime({
      catalog: graphs,
      toolCatalog: tools,
      async runAgent(_node, input, context) {
        childTools = context.tools.map((tool) => tool.name);
        return input;
      },
    }).execute(parent, { value: 1 });

    expect(result.status).toBe("completed");
    expect(parent.tools).toBeUndefined();
    expect(childTools).toEqual(["read", "__graph_complete__"]);
  });

  it("allows explicit unsafe resolution but records a warning and preserves protocol tools", async () => {
    const tools = new ToolCatalog();
    tools.register({ name: "secret" });
    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));
    let names: string[] = [];
    const result = await new GraphRuntime({
      toolCatalog: tools,
      eventBus,
      unsafeToolResolver: () => ["secret"],
      async runAgent(_node, input, context) {
        names = context.tools.map((tool) => tool.name);
        return input;
      },
    }).execute(singleAgent({ id: "unsafe" }), { value: 1 });

    expect(result.status).toBe("completed");
    expect(names).toEqual(["secret", "__graph_complete__"]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "runtime_warning", code: "unsafe-tool-policy-bypass", stageId: "main" }),
    ]));
  });
});

describe("Phase 3 Skills and Host baseline", () => {
  it("overlays Graph and Node Skills with versions and fingerprints", async () => {
    const skills = new SkillCatalog();
    skills.register({ name: "graph-skill", version: "1", source: "memory", content: "graph" });
    skills.register({ name: "node-skill", version: "2", source: "memory", content: "node" });
    let context: AgentExecutionContext | undefined;
    const graph = singleAgent({
      id: "skills",
      graphSkills: [skillRef("graph-skill", "1")],
      nodeSkills: [skillRef("node-skill", "2")],
    });
    await new GraphRuntime({
      skillCatalog: skills,
      async runAgent(_node, input, current) {
        context = current;
        return input;
      },
    }).execute(graph, { value: 1 });

    expect(context?.skills.map((skill) => `${skill.name}@${skill.version}`)).toEqual([
      "graph-skill@1",
      "node-skill@2",
    ]);
    expect(context?.skills.every((skill) => /^[a-f0-9]{64}$/.test(skill.fingerprint))).toBe(true);
  });

  it("does not leak parent Graph Skills into child Graph invocations", async () => {
    const skills = new SkillCatalog();
    skills.register({ name: "parent-skill", source: "memory", content: "parent" });
    skills.register({ name: "child-skill", source: "memory", content: "child" });
    const child = singleAgent({ id: "skill-child", graphSkills: [skillRef("child-skill")] });
    const parent = defineGraph({
      id: "skill-parent",
      version: "1",
      goal: "parent",
      input: Value,
      output: Value,
      skills: [skillRef("parent-skill")],
      context: { background: { select: "none" } },
      entries: [entry("main", { to: "child" })],
      stages: {
        child: {
          node: graphNode({ subGoal: "child", input: Value, output: Value, graph: graphRef("skill-child", "1") }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const graphs = new GraphCatalog();
    graphs.register(child);
    graphs.register(parent);
    let childSkills: string[] = [];
    await new GraphRuntime({
      catalog: graphs,
      skillCatalog: skills,
      async runAgent(_node, input, context) {
        childSkills = context.skills.map((skill) => skill.name);
        return input;
      },
    }).execute(parent, { value: 1 });

    expect(childSkills).toEqual(["child-skill"]);
  });

  it("fails required missing Skills, ignores optional ones, and records baseline selection", async () => {
    const required = await new GraphRuntime({
      runAgent: async (_node, input) => input,
    }).execute(singleAgent({ id: "required", graphSkills: [skillRef("missing")] }), { value: 1 });
    expect(required).toMatchObject({ status: "failed", failure: { code: "host-unavailable", phase: "host" } });

    const events: RuntimeEvent[] = [];
    const eventBus = new RuntimeEventBus();
    eventBus.subscribe((event) => events.push(event));
    const optional = await new GraphRuntime({
      baseline: { kind: "inherit", fingerprint: "session-1" },
      eventBus,
      runAgent: async (_node, input, context) => {
        expect(context.baseline).toEqual({ kind: "inherit", fingerprint: "session-1" });
        expect(context.skills).toEqual([]);
        return input;
      },
    }).execute(singleAgent({
      id: "optional",
      graphSkills: [skillRef("missing", undefined, false)],
    }), { value: 1 });

    expect(optional.status).toBe("completed");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "host_baseline_selected", baseline: "inherit", fingerprint: "session-1" }),
      expect.objectContaining({ type: "runtime_warning", code: "unsafe-host-baseline" }),
    ]));
  });

  it("uses a custom Skill resolver for both preflight and Agent scope", async () => {
    const skills = new SkillCatalog({
      resolver: (ref) => ref.name === "generated"
        ? { name: ref.name, version: ref.version, source: "generated", content: "generated instructions" }
        : undefined,
    });
    let resolved: string[] = [];
    const result = await new GraphRuntime({
      skillCatalog: skills,
      async runAgent(_node, input, context) {
        resolved = context.skills.map((skill) => `${skill.name}:${skill.source}:${skill.fingerprint.length}`);
        return input;
      },
    }).execute(singleAgent({
      id: "custom-skill-resolver",
      graphSkills: [skillRef("generated")],
    }), { value: 1 });

    expect(result.status).toBe("completed");
    expect(resolved).toEqual(["generated:generated:64"]);
  });
});
