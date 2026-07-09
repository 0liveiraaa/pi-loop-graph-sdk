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
    sendMessage: vi.fn((_message: any, options?: { triggerTurn?: boolean }) => {
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
    emit(eventName: string, event: any) {
      for (const handler of handlers.get(eventName) ?? []) {
        handler(event);
      }
    },
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
  });

  describe("钩子注册", () => {
    it("注册 context / tool_result / agent_end / session_start 钩子", () => {
      const pi = fakePi();
      createLoopGraphExtension(pi);

      const eventNames = (pi.on as any).mock.calls.map((c: any[]) => c[0]);
      expect(eventNames).toContain("context");
      expect(eventNames).toContain("tool_result");
      expect(eventNames).toContain("agent_end");
      expect(eventNames).toContain("session_start");
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
      ])).resolves.toBeUndefined();
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
});
