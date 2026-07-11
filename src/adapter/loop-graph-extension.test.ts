// ============================================================
//  loop-graph-extension 工厂测试
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { createLoopGraphExtension } from "./loop-graph-extension.js";
import type { LoopGraphExtension } from "./loop-graph-extension.js";
import type { Graph, Edge, Entry, Node } from "../type.js";
import { END } from "../type.js";

// ── 帮助函数：构造最小 fake pi 对象 ──

function fakePi() {
  const handlers = new Map<string, Function[]>();
  const sentMessages: any[] = [];
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((eventName: string, handler: Function) => {
      const existing = handlers.get(eventName) ?? [];
      existing.push(handler);
      handlers.set(eventName, existing);
    }),
    setActiveTools: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "__graph_complete__"]),
    getAllTools: vi.fn(() => [{ name: "read" }, { name: "__graph_complete__" }]),
    sendMessage: vi.fn((message: any, options?: { triggerTurn?: boolean }) => {
      sentMessages.push({ ...message, _options: options });
      if (!options?.triggerTurn) return;
      queueMicrotask(() => {
        for (const handler of handlers.get("tool_result") ?? []) {
          handler({
            toolName: "__graph_complete__",
            details: { status: "ok", result: { fromAgent: true } },
          });
        }
        for (const handler of handlers.get("agent_end") ?? []) {
          handler({});
        }
      });
    }),
    sendUserMessage: vi.fn(),
    emit(eventName: string, event: any) {
      let result: unknown;
      for (const handler of handlers.get(eventName) ?? []) {
        result = handler(event);
      }
      return result;
    },
    _sentMessages: sentMessages,
  } as any;
}

/** 构造一个最小可用的图（无 invocation，纯内部图） */
function minimalGraph(id = "test_graph"): Graph {
  const node: Node = {
    kind: "code",
    id: "start",
    subGoal: "测试节点",
    async execute(_instance, _input, _ctx) {
      return { nodeId: "start", status: "ok", result: {} };
    },
  };

  const entry: Entry = {
    id: "main",
    guard: () => true,
    startNodeId: "start",
  };

  const edge: Edge = {
    id: "start_to_end",
    from: "start",
    to: END,
    priority: 10,
    guard: () => true,
    migrate(_instance, completion) {
      return {
        frame: { nodeId: completion.nodeId, status: completion.status, summary: "done", result: completion.result },
      };
    },
  };

  return {
    id,
    goal: "最小测试图",
    entries: [entry],
    nodes: { start: node },
    routing: {
      start: {
        nodeId: "start",
        edges: [edge],
        router: { kind: "priority-first" },
      },
    },
  };
}

/** 构造带 invocation 的最小图（有命令注册） */
function invocableGraph(name = "test_cmd"): Graph {
  const g = minimalGraph(`invocable_${name}`);
  g.invocation = {
    name,
    description: "测试命令",
    inputSchema: { type: "object", properties: {} },
  };
  return g;
}

function edgeToEnd(nodeId: string): Edge {
  return {
    id: `${nodeId}_end`,
    from: nodeId,
    to: END,
    priority: 1,
    guard: () => true,
    migrate(_instance, completion) {
      return {
        frame: {
          nodeId: completion.nodeId,
          status: completion.status,
          summary: `${nodeId} done`,
          result: completion.result,
        },
      };
    },
  };
}

function edgeToNext(from: string, to: string): Edge {
  return {
    id: `${from}_to_${to}`,
    from,
    to,
    priority: 1,
    guard: () => true,
    migrate(_instance, completion) {
      return {
        frame: {
          nodeId: completion.nodeId,
          status: completion.status,
          summary: `${from} done`,
          result: completion.result,
        },
      };
    },
  };
}

function terminalGraph(id: string, node: Node): Graph {
  return {
    id,
    goal: id,
    entries: [{ id: "entry", guard: () => true, startNodeId: node.id }],
    nodes: { [node.id]: node },
    routing: {
      [node.id]: { nodeId: node.id, edges: [edgeToEnd(node.id)], router: { kind: "first-match" } },
    },
  };
}

// ── 测试 ──

describe("createLoopGraphExtension", () => {
  describe("基础创建", () => {
    it("无需全局初始化即可创建实例", () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      expect(loop).toBeDefined();
      expect(loop.registerGraph).toBeTypeOf("function");
      expect(loop.executeGraph).toBeTypeOf("function");
    });

    it("注册内部图（无 invocation）不创建命令/工具", () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const g = minimalGraph();

      loop.registerGraph(g);

      // 无 invocation 的图不应注册命令
      expect(pi.registerCommand).not.toHaveBeenCalled();
      expect(pi.registerTool).toHaveBeenCalledTimes(1); // 只有 __graph_complete__
    });

    it("注册带 invocation 的图会创建命令和工具", () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const g = invocableGraph("my_cmd");

      loop.registerGraph(g);

      expect(pi.registerCommand).toHaveBeenCalledWith(
        "my_cmd",
        expect.objectContaining({ description: "测试命令" }),
      );
      expect(pi.registerTool).toHaveBeenCalledTimes(2); // __graph_complete__ + my_cmd
    });

    it("runtimeOnly 剥离 invocation 时不改写原 graph 定义", () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, { runtimeOnly: true });
      const graph = invocableGraph("isolated_cmd");
      const originalNodes = graph.nodes;
      const originalRouting = graph.routing;
      const originalInvocation = graph.invocation;

      loop.registerGraph(graph);

      // runtime-only 只禁止向外层 pi 注册入口；定义内的函数与引用保持只读共享。
      expect(graph.invocation).toBe(originalInvocation);
      expect(graph.nodes).toBe(originalNodes);
      expect(graph.routing).toBe(originalRouting);
      expect(pi.registerCommand).not.toHaveBeenCalled();
      expect(pi.registerTool).toHaveBeenCalledTimes(1);
    });
  });

  describe("demo 图默认行为", () => {
    it("默认不注册 demo 图", () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);

      // demo 图不应被注册（没有命令注册 demo 图的 invocation name）
      const cmdNames = (pi.registerCommand as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(cmdNames).not.toContain("echo-test");
      expect(cmdNames).not.toContain("probe");
      expect(cmdNames).not.toContain("chain");
      expect(cmdNames).not.toContain("sub");
      expect(cmdNames).not.toContain("validate-test");
    });

    it("demoGraphs: true 时注册所有 demo 图", () => {
      const pi = fakePi();
      createLoopGraphExtension(pi, { demoGraphs: true });

      const cmdNames = (pi.registerCommand as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(cmdNames).toContain("echo-test");
      expect(cmdNames).toContain("probe");
      expect(cmdNames).toContain("chain");
      expect(cmdNames).toContain("sub");
      expect(cmdNames).toContain("validate-test");
    });
  });

  describe("实例隔离", () => {
    it("多个实例的注册表不互相污染", () => {
      const pi1 = fakePi();
      const pi2 = fakePi();

      const loop1 = createLoopGraphExtension(pi1);
      const loop2 = createLoopGraphExtension(pi2);

      loop1.registerGraph(invocableGraph("cmd_a"));
      loop2.registerGraph(invocableGraph("cmd_b"));

      // pi1 只看到 cmd_a
      const cmds1 = (pi1.registerCommand as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(cmds1).toContain("cmd_a");
      expect(cmds1).not.toContain("cmd_b");

      // pi2 只看到 cmd_b
      const cmds2 = (pi2.registerCommand as any).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(cmds2).toContain("cmd_b");
      expect(cmds2).not.toContain("cmd_a");
    });

    it("同一个 pi 上创建多个实例时只注册一次 __graph_complete__", () => {
      const pi = fakePi();

      createLoopGraphExtension(pi);
      createLoopGraphExtension(pi);

      const toolNames = (pi.registerTool as any).mock.calls.map(
        (c: any[]) => c[0].name,
      );
      expect(toolNames.filter((name: string) => name === "__graph_complete__")).toHaveLength(1);
    });
  });

  describe("默认工具", () => {
    it("执行节点时合并 defaultTools 和节点 tools", async () => {
      const pi = fakePi();
      // 注册期 + 首次执行校验需要这些工具在 getAllTools 中
      (pi.getAllTools as any).mockReturnValue([
        { name: "read" },
        { name: "__graph_complete__" },
        { name: "global_tool" },
        { name: "node_tool" },
      ]);
      const loop = createLoopGraphExtension(pi, { defaultTools: ["global_tool"] });
      const graph = minimalGraph("default_tools");
      graph.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "测试默认工具",
        tools: ["node_tool"],
        async execute() {
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(graph, { source: "command", args: "" });

      expect(pi.setActiveTools).toHaveBeenCalledWith([
        "read",
        "global_tool",
        "node_tool",
        "__graph_complete__",
      ]);
    });
  });

  describe("重复注册保护", () => {
    it("重复注册同一图抛错", () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const g = minimalGraph("dup");

      loop.registerGraph(g);
      expect(() => loop.registerGraph(g)).toThrow('图 "dup" 已注册');
    });

    it("注册时检测节点内重复工具名并抛错", () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);

      const nodeWithDupTools: Node = {
        kind: "code",
        id: "bad",
        subGoal: "bad node",
        tools: ["tool_a", "tool_a"],
        async execute() {
          return { nodeId: "bad", status: "ok", result: {} };
        },
      };

      const g: Graph = {
        id: "dup_tools",
        goal: "dup tools",
        entries: [{ id: "e", guard: () => true, startNodeId: "bad" }],
        nodes: { bad: nodeWithDupTools },
        routing: {
          bad: {
            nodeId: "bad",
            edges: [{
              id: "done",
              from: "bad",
              to: END,
              priority: 1,
              guard: () => true,
              migrate(_i, c) {
                return { frame: { nodeId: c.nodeId, status: "ok", summary: "done", result: {} } };
              },
            }],
            router: { kind: "first-match" },
          },
        },
      };

      expect(() => loop.registerGraph(g)).toThrow(/DUPLICATE_TOOL_IN_NODE|工具校验失败/);
    });

    it("首次 executeGraph 时校验未注册工具并抛错", async () => {
      const pi = fakePi();
      // getAllTools 只返回 read 和 __graph_complete__
      pi.getAllTools = vi.fn(() => [
        { name: "read" },
        { name: "__graph_complete__" },
      ]);

      const loop = createLoopGraphExtension(pi);

      const nodeWithBadTool: Node = {
        kind: "code",
        id: "bad",
        subGoal: "bad node",
        tools: ["unregistered_tool"],
        async execute() {
          return { nodeId: "bad", status: "ok", result: {} };
        },
      };

      const g: Graph = {
        id: "unreg",
        goal: "unregistered",
        entries: [{ id: "e", guard: () => true, startNodeId: "bad" }],
        nodes: { bad: nodeWithBadTool },
        routing: {
          bad: {
            nodeId: "bad",
            edges: [{
              id: "done",
              from: "bad",
              to: END,
              priority: 1,
              guard: () => true,
              migrate(_i, c) {
                return { frame: { nodeId: c.nodeId, status: "ok", summary: "done", result: {} } };
              },
            }],
            router: { kind: "first-match" },
          },
        },
      };

      // 注册期不报错（工具可能尚未注册）
      loop.registerGraph(g);

      // 首次执行时报错
      await expect(
        loop.executeGraph(g, { source: "command", args: "" }),
      ).rejects.toThrow(/TOOL_NOT_REGISTERED|工具存在性校验失败/);
    });

    it("delegate graph-node 在 host 接线前明确拒绝，不静默按 call 执行", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const parent = minimalGraph("unsupported_delegate");
      parent.nodes.start = {
        kind: "graph",
        id: "start",
        subGoal: "delegate",
        graph: minimalGraph("child_delegate"),
        boundary: "delegate",
      };

      await expect(loop.executeGraph(parent, { source: "command", args: "" }))
        .rejects.toThrow(/UNSUPPORTED_GRAPH_BOUNDARY|尚未由当前执行载体支持/);
    });
  });

  describe("钩子注册", () => {
    it("注册 context / tool_result / agent_end / session_start / compaction 钩子", () => {
      const pi = fakePi();
      createLoopGraphExtension(pi);

      const eventNames = (pi.on as any).mock.calls.map((c: any[]) => c[0]);
      expect(eventNames).toContain("context");
      expect(eventNames).toContain("tool_result");
      expect(eventNames).toContain("agent_end");
      expect(eventNames).toContain("session_start");
      expect(eventNames).toContain("session_before_compact");
      expect(eventNames).toContain("session_compact");
    });
  });

  describe("compaction checkpoint", () => {
    it("活动节点 compaction 后保留原生 summary/recent messages，并从空 frame 基线重新生长", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let retryProjection: any;

      const first: Node = {
        kind: "code", id: "first", subGoal: "先完成",
        async execute() {
          return { nodeId: "first", status: "ok", result: { carried: true } };
        },
      };
      const second: Node = {
        kind: "code", id: "second", subGoal: "压缩后继续",
        async execute() {
          const scopeEntries = pi._sentMessages
            .filter((message: any) => message.customType === "loop_graph_node_scope")
            .map((message: any, index: number) => ({
              id: `scope-entry-${index}`,
              type: "custom_message",
              customType: "loop_graph_node_scope",
              details: message.details,
            }));
          pi.emit("session_before_compact", {
            reason: "overflow",
            willRetry: true,
            branchEntries: scopeEntries,
            preparation: { firstKeptEntryId: scopeEntries.at(-1)?.id },
          });
          pi.emit("session_compact", { reason: "overflow", willRetry: true });
          retryProjection = pi.emit("context", {
            messages: [
              { role: "user", content: "outer transcript" },
              { role: "compactionSummary", content: "compaction secret" },
              ...pi._sentMessages,
            ],
          });
          return { nodeId: "second", status: "ok", result: {} };
        },
      };
      const graph: Graph = {
        id: "compact_graph", goal: "compaction",
        entries: [{ id: "entry", guard: () => true, startNodeId: "first" }],
        nodes: { first, second },
        routing: {
          first: {
            nodeId: "first", router: { kind: "first-match" }, edges: [{
              id: "next", from: "first", to: "second", priority: 1, guard: () => true,
              migrate(_instance, completion) {
                return { frame: { nodeId: completion.nodeId, status: completion.status, summary: "first done", result: completion.result } };
              },
            }],
          },
          second: {
            nodeId: "second", router: { kind: "first-match" }, edges: [{
              id: "end", from: "second", to: END, priority: 1, guard: () => true,
              migrate(_instance, completion) {
                return { frame: { nodeId: completion.nodeId, status: completion.status, summary: "second done", result: completion.result } };
              },
            }],
          },
        },
      };

      await loop.executeGraph(graph, { source: "command", args: "" });

      const scopes = pi._sentMessages.filter((message: any) => message.customType === "loop_graph_node_scope");
      const secondScopes = scopes.filter((message: any) => message.details.nodeId === "second");
      expect(secondScopes).toHaveLength(1);

      const text = retryProjection.messages.map((message: any) => String(message.content)).join("\n");
      expect(retryProjection.messages.some((message: any) => message.role === "compactionSummary")).toBe(true);
      expect(text).not.toContain("first done");
      expect(text).toContain("nodeId: second");
      expect(text).not.toContain("outer transcript");
      expect(text).toContain("compaction secret");
    });

    it("无活动图节点时忽略 compaction，不写入 checkpoint", () => {
      const pi = fakePi();
      createLoopGraphExtension(pi);
      pi.emit("session_compact", { reason: "manual", willRetry: false });
      expect(pi._sentMessages).toHaveLength(0);
    });
  });

  describe("子图 agent 节点", () => {
    it("子图内的 agent 节点可以通过 __graph_complete__ 完成", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);

      const childAgentNode: Node = {
        kind: "code",
        id: "child_agent",
        subGoal: "子图 agent 节点",
        async execute(_instance, _input, ctx) {
          return ctx.runAgent({ prompt: "run child agent" });
        },
      };

      const childGraph: Graph = {
        id: "child_agent_graph",
        goal: "验证子图 agent 完成",
        entries: [{ id: "child_entry", guard: () => true, startNodeId: "child_agent" }],
        nodes: { child_agent: childAgentNode },
        routing: {
          child_agent: {
            nodeId: "child_agent",
            edges: [{
              id: "child_done",
              from: "child_agent",
              to: END,
              priority: 10,
              guard: () => true,
              migrate(_instance, completion) {
                return {
                  frame: {
                    nodeId: completion.nodeId,
                    status: completion.status,
                    summary: "child done",
                    result: completion.result,
                  },
                };
              },
            }],
            router: { kind: "first-match" },
          },
        },
      };

      const parentGraph: Graph = {
        id: "parent_graph",
        goal: "验证父图调用子图",
        entries: [{ id: "parent_entry", guard: () => true, startNodeId: "invoke_child" }],
        nodes: {
          invoke_child: {
            kind: "graph",
            id: "invoke_child",
            subGoal: "调用子图",
            graph: childGraph,
          },
        },
        routing: {
          invoke_child: {
            nodeId: "invoke_child",
            edges: [{
              id: "parent_done",
              from: "invoke_child",
              to: END,
              priority: 10,
              guard: () => true,
              migrate(_instance, completion) {
                return {
                  frame: {
                    nodeId: completion.nodeId,
                    status: completion.status,
                    summary: "parent done",
                    result: completion.result,
                  },
                };
              },
            }],
            router: { kind: "first-match" },
          },
        },
      };

      await expect(Promise.race([
        loop.executeGraph(parentGraph, { source: "command", args: "" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("subgraph timed out")), 50)),
      ])).resolves.toMatchObject({
        graphId: "parent_graph",
        status: "ok",
        result: { fromAgent: true },
        steps: 1,
      });
    });

    it("call 子图复用同一 Runtime callStack，子 Instance 与父 Instance 仍隔离", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const child: Graph = {
        id: "scope_child",
        goal: "child",
        entries: [{ id: "entry", guard: () => true, startNodeId: "child_start" }],
        nodes: {
          child_start: {
            kind: "code", id: "child_start", subGoal: "child work",
            async execute() { return { nodeId: "child_start", status: "ok", result: { child: true } }; },
          },
        },
        routing: {
          child_start: {
            nodeId: "child_start", router: { kind: "first-match" }, edges: [{
              id: "end", from: "child_start", to: END, priority: 1, guard: () => true,
              migrate(_instance, completion) {
                return { frame: { nodeId: completion.nodeId, status: completion.status, summary: "child", result: completion.result } };
              },
            }],
          },
        },
      };
      const parent: Graph = {
        id: "scope_parent",
        goal: "parent",
        entries: [{ id: "entry", guard: () => true, startNodeId: "invoke" }],
        nodes: {
          invoke: { kind: "graph", id: "invoke", subGoal: "call child", graph: child },
          finish: {
            kind: "code", id: "finish", subGoal: "finish",
            async execute() { return { nodeId: "finish", status: "ok", result: { done: true } }; },
          },
        },
        routing: {
          invoke: {
            nodeId: "invoke", router: { kind: "first-match" }, edges: [{
              id: "next", from: "invoke", to: "finish", priority: 1, guard: () => true,
              migrate(_instance, completion) {
                return { frame: { nodeId: completion.nodeId, status: completion.status, summary: "invoke", result: completion.result } };
              },
            }],
          },
          finish: {
            nodeId: "finish", router: { kind: "first-match" }, edges: [{
              id: "end", from: "finish", to: END, priority: 1, guard: () => true,
              migrate(_instance, completion) {
                return { frame: { nodeId: completion.nodeId, status: completion.status, summary: "finish", result: completion.result } };
              },
            }],
          },
        },
      };

      await expect(loop.executeGraph(parent, { source: "command", args: "" })).resolves.toMatchObject({
        graphId: "scope_parent", result: { done: true }, steps: 2,
      });

      const scopes = pi._sentMessages.filter((message: any) => message.customType === "loop_graph_node_scope");
      const [parentScope, childScope, resumedParentScope] = scopes.map((message: any) => message.details);
      expect([parentScope.nodeId, childScope.nodeId, resumedParentScope.nodeId]).toEqual([
        "invoke", "child_start", "finish",
      ]);
      expect(childScope.depth).toBe(2);
      expect(resumedParentScope.depth).toBe(1);
      expect(childScope.graphRunId).toBe(parentScope.graphRunId);
      expect(childScope.instanceId).not.toBe(parentScope.instanceId);
      expect(resumedParentScope.instanceId).toBe(parentScope.instanceId);
    });
  });

  describe("Phase 8 compose 帧段", () => {
    it("共享父 instance 的 frames/scratch，但默认 fold 只向父节点交付结果", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let parentInstanceId = "";
      let childInstanceId = "";
      let childSawParentFrame = false;
      let finishSawOnlyFoldedFrames = false;

      const child = terminalGraph("compose_child", {
        kind: "code", id: "child_work", subGoal: "child",
        async execute(instance) {
          childInstanceId = instance.id;
          childSawParentFrame = instance.frames.some((frame) => frame.nodeId === "prepare");
          instance.scratch.child = "shared";
          return { nodeId: "child_work", status: "ok", result: { child: true } };
        },
      });
      const parent: Graph = {
        id: "compose_parent", goal: "parent",
        entries: [{ id: "entry", guard: () => true, startNodeId: "prepare" }],
        nodes: {
          prepare: {
            kind: "code", id: "prepare", subGoal: "prepare",
            async execute(instance) {
              parentInstanceId = instance.id;
              instance.scratch.parent = "shared";
              return { nodeId: "prepare", status: "ok", result: { prepared: true } };
            },
          },
          compose: { kind: "graph", id: "compose", subGoal: "compose", graph: child, boundary: "compose" },
          finish: {
            kind: "code", id: "finish", subGoal: "finish",
            async execute(instance) {
              finishSawOnlyFoldedFrames = instance.frames.map((frame) => frame.nodeId).join(",") === "prepare,compose";
              return { nodeId: "finish", status: "ok", result: { scratch: instance.scratch.child } };
            },
          },
        },
        routing: {
          prepare: { nodeId: "prepare", edges: [edgeToNext("prepare", "compose")], router: { kind: "first-match" } },
          compose: { nodeId: "compose", edges: [edgeToNext("compose", "finish")], router: { kind: "first-match" } },
          finish: { nodeId: "finish", edges: [edgeToEnd("finish")], router: { kind: "first-match" } },
        },
      };

      await expect(loop.executeGraph(parent, { source: "command", args: "" })).resolves.toMatchObject({
        status: "ok", result: { scratch: "shared" }, steps: 3,
      });
      expect(childInstanceId).toBe(parentInstanceId);
      expect(childSawParentFrame).toBe(true);
      expect(finishSawOnlyFoldedFrames).toBe(true);

      const scopes = pi._sentMessages
        .filter((message: any) => message.customType === "loop_graph_node_scope")
        .map((message: any) => message.details);
      expect(scopes.map((scope: any) => [scope.nodeId, scope.depth])).toEqual([
        ["prepare", 1], ["compose", 1], ["child_work", 2], ["finish", 1],
      ]);
      expect(scopes[2].instanceId).toBe(scopes[0].instanceId);
    });

    it("custom fold 仅接收冻结快照，并可显式传出完整 segment", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let segmentWasFrozen = false;
      const child = terminalGraph("fold_child", {
        kind: "code", id: "child_work", subGoal: "child",
        async execute() {
          return { nodeId: "child_work", status: "ok", result: { nested: { value: 1 } } };
        },
      });
      const parent = terminalGraph("fold_parent", {
        kind: "graph", id: "compose", subGoal: "compose", graph: child, boundary: "compose",
        fold({ segment, finalResult }) {
          segmentWasFrozen = Object.isFrozen(segment)
            && Object.isFrozen(segment[0])
            && Object.isFrozen(segment[0].result)
            && Object.isFrozen((segment[0].result as any).nested);
          return {
            status: finalResult.status,
            result: { exported: segment.map((frame) => ({ nodeId: frame.nodeId, result: frame.result })) },
          };
        },
      });

      await expect(loop.executeGraph(parent, { source: "command", args: "" })).resolves.toMatchObject({
        status: "ok",
        result: { exported: [{ nodeId: "child_work", result: { nested: { value: 1 } } }] },
      });
      expect(segmentWasFrozen).toBe(true);
    });

    it.each(["failed", "cancelled"] as const)(
      "业务 %s 仍经过默认 fold，且不残留 child frames",
      async (status) => {
        const pi = fakePi();
        const loop = createLoopGraphExtension(pi);
        let instance: any;
        const child = terminalGraph(`compose_${status}_child`, {
          kind: "code", id: "child_work", subGoal: "child",
          async execute(shared) {
            // run 结束后该引用仍可用于验证 segment 已被 Runtime 截断。
            instance = shared;
            return { nodeId: "child_work", status, result: { status } };
          },
        });
        const parent = terminalGraph(`compose_${status}_parent`, {
          kind: "graph", id: "compose", subGoal: "compose", graph: child, boundary: "compose",
        });

        const result = await loop.executeGraph(parent, { source: "command", args: "" });
        expect(result).toMatchObject({ status, result: { status } });
        expect(instance.frames.map((frame: any) => frame.nodeId)).toEqual(["compose"]);
      },
    );

    it.each([
      ["fold throw", true],
      ["child throw", false],
    ] as const)("%s 时回滚 segment，保留父图既有 frames", async (_name, foldThrows) => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let instance: any;
      const child = terminalGraph(`rollback_child_${foldThrows}`, {
        kind: "code", id: "child_work", subGoal: "child",
        async execute(shared) {
          instance = shared;
          if (!foldThrows) throw new Error("child abort");
          return { nodeId: "child_work", status: "ok", result: {} };
        },
      });
      const parent: Graph = {
        id: `rollback_parent_${foldThrows}`, goal: "parent",
        entries: [{ id: "entry", guard: () => true, startNodeId: "before" }],
        nodes: {
          before: { kind: "code", id: "before", subGoal: "before", async execute(shared) {
            instance = shared;
            return { nodeId: "before", status: "ok", result: {} };
          } },
          compose: {
            kind: "graph", id: "compose", subGoal: "compose", graph: child, boundary: "compose",
            fold: foldThrows ? () => { throw new Error("fold abort"); } : undefined,
          },
        },
        routing: {
          before: { nodeId: "before", edges: [edgeToNext("before", "compose")], router: { kind: "first-match" } },
          compose: { nodeId: "compose", edges: [edgeToEnd("compose")], router: { kind: "first-match" } },
        },
      };

      const result = await loop.executeGraph(parent, { source: "command", args: "" });
      expect(result.status).toBe("failed");
      expect(instance.frames.map((frame: any) => frame.nodeId)).toEqual(["before"]);
    });

    it("子图达到 maxSteps 后仍归约为一个父帧，不残留内部 frames", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let instance: any;
      const child: Graph = {
        id: "max_steps_child", goal: "loop",
        entries: [{ id: "entry", guard: () => true, startNodeId: "loop" }],
        nodes: {
          loop: {
            kind: "code", id: "loop", subGoal: "loop",
            async execute(shared) {
              instance = shared;
              return { nodeId: "loop", status: "ok", result: {} };
            },
          },
        },
        routing: {
          loop: { nodeId: "loop", edges: [edgeToNext("loop", "loop")], router: { kind: "first-match" } },
        },
      };
      const parent = terminalGraph("max_steps_parent", {
        kind: "graph", id: "compose", subGoal: "compose", graph: child, boundary: "compose",
      });

      await expect(loop.executeGraph(parent, { source: "command", args: "" })).resolves.toMatchObject({
        status: "failed", result: { reason: "Max steps (50) exceeded" },
      });
      expect(instance.frames.map((frame: any) => frame.nodeId)).toEqual(["compose"]);
    });

    it.each([
      ["compose", "compose", [true, true, true]],
      ["compose", "call", [true, true, false]],
      ["call", "compose", [true, false, false]],
    ] as const)("%s → %s 的嵌套恢复正确", async (outerBoundary, innerBoundary, sameAsParent) => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const grandchild = terminalGraph(`grand_${outerBoundary}_${innerBoundary}`, {
        kind: "code", id: "grand_work", subGoal: "grand",
        async execute() { return { nodeId: "grand_work", status: "ok", result: { grand: true } }; },
      });
      const child = terminalGraph(`child_${outerBoundary}_${innerBoundary}`, {
        kind: "graph", id: "inner", subGoal: "inner", graph: grandchild, boundary: innerBoundary,
      });
      const parent: Graph = {
        id: `parent_${outerBoundary}_${innerBoundary}`, goal: "parent",
        entries: [{ id: "entry", guard: () => true, startNodeId: "outer" }],
        nodes: {
          outer: { kind: "graph", id: "outer", subGoal: "outer", graph: child, boundary: outerBoundary },
          finish: {
            kind: "code", id: "finish", subGoal: "finish",
            async execute() { return { nodeId: "finish", status: "ok", result: { done: true } }; },
          },
        },
        routing: {
          outer: { nodeId: "outer", edges: [edgeToNext("outer", "finish")], router: { kind: "first-match" } },
          finish: { nodeId: "finish", edges: [edgeToEnd("finish")], router: { kind: "first-match" } },
        },
      };

      await expect(loop.executeGraph(parent, { source: "command", args: "" })).resolves.toMatchObject({
        status: "ok", result: { done: true },
      });
      const scopes = pi._sentMessages
        .filter((message: any) => message.customType === "loop_graph_node_scope")
        .map((message: any) => message.details);
      expect(scopes.map((scope: any) => [scope.nodeId, scope.depth])).toEqual([
        ["outer", 1], ["inner", 2], ["grand_work", 3], ["finish", 1],
      ]);
      const parentId = scopes[0].instanceId;
      expect(scopes.slice(0, 3).map((scope: any) => scope.instanceId === parentId)).toEqual(sameAsParent);
      expect(scopes[3].instanceId).toBe(parentId);
    });
  });

  describe("Phase 9 GraphCallScope", () => {
    it("真实 call 生成配对且自描述的 start/end，并在返回后的 context 中清除内部消息", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const child = terminalGraph("call_scope_child", {
        kind: "code", id: "child_work", subGoal: "child",
        async execute() { return { nodeId: "child_work", status: "ok", result: { child: true } }; },
      });
      const parent = terminalGraph("call_scope_parent", {
        kind: "graph", id: "invoke", subGoal: "invoke", graph: child, boundary: "call",
      });

      await loop.executeGraph(parent, { source: "command", args: "" });

      const start = pi._sentMessages.find((message: any) => message.customType === "loop_graph_call_start");
      const end = pi._sentMessages.find((message: any) => message.customType === "loop_graph_call_end");
      expect(start?.details).toMatchObject({
        protocol: 2, graphId: "call_scope_child", boundary: "call", invocationKind: "graph-node",
      });
      expect(end?.details).toMatchObject({
        protocol: 2,
        callId: start.details.callId,
        graphId: "call_scope_child",
        boundary: "call",
        invocationKind: "graph-node",
        status: "ok",
      });

      const projected = pi.emit("context", { messages: pi._sentMessages });
      expect(projected.messages.some((message: any) =>
        message.details?.graphId === "call_scope_child"
        || message.details?.nodeId === "child_work",
      )).toBe(false);
    });

    it("无匹配边出口把真实 cancelled 状态写入 call_end", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const child: Graph = {
        id: "no_edge_child", goal: "no edge",
        entries: [{ id: "entry", guard: () => true, startNodeId: "child_work" }],
        nodes: {
          child_work: {
            kind: "code", id: "child_work", subGoal: "cancel",
            async execute() { return { nodeId: "child_work", status: "cancelled", result: { stopped: true } }; },
          },
        },
        routing: {
          child_work: { nodeId: "child_work", edges: [], router: { kind: "first-match" } },
        },
      };
      const parent = terminalGraph("no_edge_parent", {
        kind: "graph", id: "invoke", subGoal: "invoke", graph: child, boundary: "call",
      });

      await loop.executeGraph(parent, { source: "command", args: "" });
      const end = pi._sentMessages.find((message: any) =>
        message.customType === "loop_graph_call_end" && message.details?.graphId === "no_edge_child",
      );
      expect(end?.details.status).toBe("cancelled");
    });

    it("共享 Session 的 call 活跃时阻止 compaction，避免 summary 穿透边界", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let compactDecision: unknown;
      const child = terminalGraph("compact_guard_child", {
        kind: "code", id: "child_work", subGoal: "child",
        async execute() {
          compactDecision = pi.emit("session_before_compact", {
            reason: "overflow", willRetry: true,
          });
          return { nodeId: "child_work", status: "ok", result: {} };
        },
      });
      const parent = terminalGraph("compact_guard_parent", {
        kind: "graph", id: "invoke", subGoal: "invoke", graph: child, boundary: "call",
      });

      await loop.executeGraph(parent, { source: "command", args: "" });
      expect(compactDecision).toEqual({ cancel: true });
    });

    it("root 节点没有共享子调用时不阻止正常 compaction", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let compactDecision: unknown = "unset";
      const graph = terminalGraph("root_compact", {
        kind: "code", id: "root_work", subGoal: "root",
        async execute() {
          compactDecision = pi.emit("session_before_compact", {
            reason: "threshold", willRetry: false,
          });
          return { nodeId: "root_work", status: "ok", result: {} };
        },
      });

      await loop.executeGraph(graph, { source: "command", args: "" });
      expect(compactDecision).toBeUndefined();
    });

    it("mapInput 抛错仍闭合 call scope，且后续图可正常执行", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const child = terminalGraph("map_input_error_child", {
        kind: "code", id: "child_work", subGoal: "child",
        async execute() { return { nodeId: "child_work", status: "ok", result: {} }; },
      });
      child.entries[0].mapInput = () => { throw new Error("map input failed"); };
      const parent = terminalGraph("map_input_error_parent", {
        kind: "graph", id: "invoke", subGoal: "invoke", graph: child, boundary: "call",
      });

      await expect(loop.executeGraph(parent, { source: "command", args: "" })).resolves.toMatchObject({
        status: "failed", result: { reason: "map input failed" },
      });
      const start = pi._sentMessages.find((message: any) =>
        message.customType === "loop_graph_call_start" && message.details?.graphId === "map_input_error_child",
      );
      const end = pi._sentMessages.find((message: any) =>
        message.customType === "loop_graph_call_end" && message.details?.callId === start?.details.callId,
      );
      expect(end?.details.status).toBe("failed");
      await expect(loop.executeGraph(minimalGraph("after_map_error"), { source: "command", args: "" }))
        .resolves.toMatchObject({ status: "ok" });
    });
  });

  describe("路由契约", () => {
    it("执行图时等待异步 custom router 再迁移到下一节点", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const visited: string[] = [];

      const startNode: Node = {
        kind: "code",
        id: "start",
        subGoal: "起点",
        async execute() {
          visited.push("start");
          return { nodeId: "start", status: "ok", result: { next: true } };
        },
      };
      const nextNode: Node = {
        kind: "code",
        id: "next",
        subGoal: "后继",
        async execute() {
          visited.push("next");
          return { nodeId: "next", status: "ok", result: { done: true } };
        },
      };
      const toNext: Edge = {
        id: "to_next",
        from: "start",
        to: "next",
        priority: 1,
        guard: () => true,
        migrate(_instance, completion) {
          return {
            frame: {
              nodeId: completion.nodeId,
              status: completion.status,
              summary: "to next",
              result: completion.result,
            },
            input: { fromStart: true },
          };
        },
      };
      const done: Edge = {
        id: "done",
        from: "next",
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

      await loop.executeGraph({
        id: "async_custom_router_graph",
        goal: "验证异步自定义路由",
        entries: [{ id: "main", guard: () => true, startNodeId: "start" }],
        nodes: { start: startNode, next: nextNode },
        routing: {
          start: {
            nodeId: "start",
            edges: [toNext],
            router: {
              kind: "custom",
              async fn(edges) {
                await Promise.resolve();
                return edges[0] ?? null;
              },
            },
          },
          next: {
            nodeId: "next",
            edges: [done],
            router: { kind: "first-match" },
          },
        },
      }, { source: "command", args: "" });

      expect(visited).toEqual(["start", "next"]);
      expect(pi.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ customType: "loop_graph_error" }),
      );
    });
  });

  describe("横切机制", () => {
    it("onNodeEnter 在 execute 之前跑，且写入 scratch 对 execute 可见", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];
      let seenScratch: unknown = undefined;

      const g = minimalGraph("mech_scratch");
      g.mechanisms = [
        {
          name: "prep",
          async onNodeEnter(ctx) {
            order.push("apply");
            ctx.instance.scratch.prepared = 42;
          },
        },
      ];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "读 scratch",
        async execute(instance) {
          order.push("execute");
          seenScratch = instance.scratch.prepared;
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(order).toEqual(["apply", "execute"]);
      expect(seenScratch).toBe(42);
    });

    it("onNodeEnter 未定义时跳过", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const applied: string[] = [];

      const g = minimalGraph("mech_skip");
      g.mechanisms = [
        { name: "yes", async onNodeEnter() { applied.push("yes"); } },
        { name: "no" },
      ];

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(applied).toEqual(["yes"]);
    });

    it("onNodeEnter 抛错记日志但不中止节点", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let executed = false;

      const g = minimalGraph("mech_throw");
      g.mechanisms = [
        { name: "boom", async onNodeEnter() { throw new Error("mech failed"); } },
      ];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "抛错后仍执行",
        async execute() {
          executed = true;
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(executed).toBe(true);
      expect(pi.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ customType: "loop_graph_error" }),
        expect.anything(),
      );
    });

    it("appendContext 向消息流追加内容且不触发额外 turn", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);

      const g = minimalGraph("mech_append");
      g.mechanisms = [
        {
          name: "inject",
          async onNodeEnter(ctx) {
            ctx.appendContext("机制注入的上下文");
          },
        },
      ];

      await loop.executeGraph(g, { source: "command", args: "" });

      // 以 loop_graph_mechanism 追加，display:false，且未带 triggerTurn
      const call = (pi.sendMessage as any).mock.calls.find(
        (c: any[]) => c[0]?.customType === "loop_graph_mechanism",
      );
      expect(call).toBeDefined();
      expect(call[0].content).toBe("机制注入的上下文");
      expect(call[0].display).toBe(false);
      expect(call[1]?.triggerTurn).toBeFalsy();
    });

    it("全局机制先于局部机制执行", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];

      const g = minimalGraph("mech_order");
      g.mechanisms = [
        { name: "global", async onNodeEnter() { order.push("global"); } },
      ];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "顺序",
        mechanisms: [
          { name: "local", async onNodeEnter() { order.push("local"); } },
        ],
        async execute() {
          order.push("execute");
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(order).toEqual(["global", "local", "execute"]);
    });
  });
});
