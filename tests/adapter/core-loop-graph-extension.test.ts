import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createLoopGraphExtension } from "../../src/adapter/loop-graph-extension.js";
import { defineGraph } from "../../src/builders/graph.js";
import { agentNode, codeNode } from "../../src/builders/node.js";
import { entry, finish, firstMatch } from "../../src/builders/route.js";
import { skillRef } from "../../src/builders/refs.js";
import { SkillCatalog } from "../../src/host/skill-catalog.js";
import { ToolCatalog } from "../../src/host/tool-catalog.js";

const Empty = Type.Object({});
const AgentResult = Type.Object({ fromAgent: Type.Boolean() });

function fakePi() {
  const handlers = new Map<string, Function[]>();
  const registeredTools: any[] = [];
  const contextResults: any[] = [];
  const pi = {
    registerTool: vi.fn((tool: any) => registeredTools.push(tool)),
    registerCommand: vi.fn(),
    on: vi.fn((name: string, handler: Function) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    getAllTools: vi.fn(() => registeredTools),
    getActiveTools: vi.fn(() => ["read"]),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn((_message: any, options?: { triggerTurn?: boolean }) => {
      if (!options?.triggerTurn) return;
      queueMicrotask(async () => {
        for (const handler of handlers.get("context") ?? []) {
          contextResults.push(await handler({
            type: "context",
            messages: [
              { role: "custom", customType: "loop_graph_context", content: "stale", display: false, timestamp: 1 },
              { role: "compactionSummary", summary: "folded transcript", tokensBefore: 10, timestamp: 2 },
            ],
          }));
        }
        for (const handler of handlers.get("tool_result") ?? []) {
          await handler({
            toolName: "__graph_complete__",
            input: { result: { fromAgent: true } },
          });
        }
        for (const handler of handlers.get("agent_end") ?? []) await handler({});
      });
    }),
    sendUserMessage: vi.fn(),
    _registeredTools: registeredTools,
    _contextResults: contextResults,
  };
  return pi as any;
}

function agentGraph() {
  return defineGraph({
    id: "public-agent",
    version: "1",
    goal: "execute agent",
    input: Empty,
    output: AgentResult,
    context: { background: { select: "none" } },
    entries: [entry<object>("main", { to: "agent" })],
    stages: {
      agent: {
        node: agentNode({ subGoal: "answer", input: Empty, output: AgentResult }),
        route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
      },
    },
  });
}

describe("Core LoopGraphExtension", () => {
  it("registerGraph does not expose until exposeGraph is called", () => {
    const pi = fakePi();
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true });
    const graph = agentGraph();
    extension.registerGraph(graph);
    expect(pi.registerCommand).not.toHaveBeenCalled();

    extension.exposeGraph({ id: graph.id, version: graph.version }, { kind: "command", name: "public-agent" });
    expect(pi.registerCommand).toHaveBeenCalledWith("public-agent", expect.objectContaining({ handler: expect.any(Function) }));

    extension.exposeGraph({ id: graph.id, version: graph.version }, { kind: "tool", name: "public_agent_tool" });
    expect(pi._registeredTools.some((tool: any) => tool.name === "public_agent_tool")).toBe(true);
  });

  it("executes Agent Nodes and Code Node runAgent through the Pi Host bridge", async () => {
    const pi = fakePi();
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true });
    await expect(extension.executeGraph(agentGraph(), { source: "tool", params: {} })).resolves.toMatchObject({
      status: "completed",
      output: { fromAgent: true },
    });

    const hybrid = defineGraph({
      id: "public-code-agent",
      version: "1",
      goal: "execute code agent",
      input: Empty,
      output: AgentResult,
      context: { background: { select: "none" } },
      entries: [entry<object>("main", { to: "code" })],
      stages: {
        code: {
          node: codeNode({
            subGoal: "run agent",
            input: Empty,
            output: AgentResult,
            async execute({ runAgent, complete }) {
              const completion = await runAgent({ prompt: "answer", output: AgentResult });
              return complete(completion.result as { fromAgent: boolean });
            },
          }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    await expect(extension.executeGraph(hybrid, { source: "tool", params: {} })).resolves.toMatchObject({
      status: "completed",
      output: { fromAgent: true },
    });
  });

  it("uses the same capability preflight during registration and execution", () => {
    const pi = fakePi();
    const missingTool = { ...agentGraph(), id: "missing-tool", tools: ["echo"] };
    expect(() => createLoopGraphExtension(pi, { runtimeOnly: true }).registerGraph(missingTool)).toThrow(/Tool Catalog/i);

    const tools = new ToolCatalog();
    tools.register({
      name: "echo",
      description: "echo input",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (input) => input,
    });
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true, toolCatalog: tools });
    expect(() => extension.registerGraph(missingTool)).not.toThrow();
    expect(pi._registeredTools.map((tool: any) => tool.name)).toContain("echo");
  });

  it("registers executable ToolCatalog entries for direct execution without prior graph registration", async () => {
    const pi = fakePi();
    const tools = new ToolCatalog();
    tools.register({
      name: "echo",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (input) => input,
    });
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true, toolCatalog: tools });

    await extension.executeGraph(agentGraph(), { source: "tool", params: {} });
    expect(pi._registeredTools.map((tool: any) => tool.name)).toContain("echo");
  });

  it("rejects Catalog-only tool names that have no Pi or executable Host implementation", async () => {
    const pi = fakePi();
    const tools = new ToolCatalog();
    tools.register({ name: "echo" });
    const graph = { ...agentGraph(), id: "unimplemented-tool", tools: ["echo"] };
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true, toolCatalog: tools });

    expect(() => extension.registerGraph(graph)).toThrow(/Host tool unavailable: echo/i);
    await expect(extension.executeGraph(graph, { source: "tool", params: {} })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "tool-unavailable", phase: "host" },
    });
  });

  it("rejects required Skills at registration and allows optional missing Skills", () => {
    const pi = fakePi();
    const required = {
      ...agentGraph(),
      id: "required-skill",
      skills: [skillRef("missing", undefined, true)],
    };
    const optional = {
      ...agentGraph(),
      id: "optional-skill",
      skills: [skillRef("missing", undefined, false)],
    };
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true, skillCatalog: new SkillCatalog() });
    expect(() => extension.registerGraph(required)).toThrow(/Required Skill unavailable/);
    expect(() => extension.registerGraph(optional)).not.toThrow();
  });

  it("propagates cancellation before creating a Graph Invocation", async () => {
    const pi = fakePi();
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true });
    const controller = new AbortController();
    controller.abort();
    await expect(extension.executeGraph(agentGraph(), { source: "tool", params: {} }, {
      signal: controller.signal,
    })).resolves.toMatchObject({ status: "cancelled", steps: 0 });
    expect(pi.sendMessage).not.toHaveBeenCalledWith(expect.anything(), { triggerTurn: true });
  });

  it("re-projects one canonical Context Snapshot after compaction-like message replacement", async () => {
    const pi = fakePi();
    const graph = defineGraph({
      ...agentGraph(),
      id: "context-hook",
      input: Type.Object({ visible: Type.String(), secret: Type.String() }),
      context: {
        background: {
          select: (input) => ({ visible: input.visible }),
          render: ({ selected }) => `VISIBLE:${(selected as { visible: string } | null)?.visible}`,
        },
      },
      stages: {
        agent: {
          ...agentGraph().stages.agent,
          node: agentNode({
            subGoal: "answer",
            input: Type.Object({ visible: Type.String(), secret: Type.String() }),
            output: AgentResult,
            context: { focus: { select: (input) => ({ visible: input.visible }) } },
          }),
        },
      },
    });
    const extension = createLoopGraphExtension(pi, { runtimeOnly: true });
    await extension.executeGraph(graph, { source: "tool", params: { visible: "yes", secret: "no" } });

    const messages = pi._contextResults.at(-1).messages;
    const canonical = messages.filter((message: any) => message.customType === "loop_graph_context");
    expect(canonical).toHaveLength(1);
    expect(JSON.stringify(canonical[0].content)).toContain("VISIBLE:yes");
    expect(JSON.stringify(canonical[0].content)).not.toContain("no");
    expect(messages.some((message: any) => message.role === "compactionSummary")).toBe(true);
    expect(canonical[0].details).toMatchObject({
      graphInvocationId: expect.any(String),
      nodeVisitId: expect.any(String),
      agentRunId: expect.any(String),
    });
  });
});
