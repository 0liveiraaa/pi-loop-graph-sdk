// ============================================================
//  IsolatedGraphSession 测试
// ============================================================

import { describe, expect, it, beforeAll, vi } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Edge, Entry, Graph, GraphRunRequest, GraphRunResult, Mechanism, Node, NodeCompletion, NodeInput } from "../type.js";
import { END } from "../type.js";
import { createIsolatedGraphSessionFactory } from "./isolated-graph-session.js";
import type { IsolatedGraphSessionFactoryOptions } from "./isolated-graph-session.js";

// ── 共享基础设施 ──

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(() => {
  authStorage = AuthStorage.create();
  modelRegistry = ModelRegistry.create(authStorage);
});

function factoryOptions(overrides?: Partial<IsolatedGraphSessionFactoryOptions>): IsolatedGraphSessionFactoryOptions {
  return {
    authStorage,
    modelRegistry,
    defaultTools: [],
    ...overrides,
  };
}

/** 委托请求（工厂创建 delegate session 用） */
function delegateReq(bg?: Record<string, unknown>): GraphRunRequest {
  return { background: bg ?? {}, invocationKind: "tool", boundary: "delegate" };
}

// ── 测试图构造 ──

/** 单节点纯代码图 */
function pureCodeGraph(): Graph {
  const node: Node = {
    kind: "code",
    id: "step1",
    subGoal: "纯代码节点",
    async execute(_instance, input, _ctx) {
      return {
        nodeId: "step1",
        status: "ok",
        result: { value: (input.data as any).x ?? 0 + 1 },
      };
    },
  };

  return {
    id: "pure_code",
    goal: "纯代码图",
    entries: [{ id: "main", guard: () => true, startNodeId: "step1" }],
    nodes: { step1: node },
    routing: {
      step1: {
        nodeId: "step1",
        edges: [{
          id: "done",
          from: "step1",
          to: END,
          priority: 10,
          guard: () => true,
          migrate(_instance, completion) {
            return {
              frame: { nodeId: completion.nodeId, status: completion.status, summary: "done", result: completion.result },
            };
          },
        }],
        router: { kind: "first-match" },
      },
    },
  };
}

/** 两节点链式图 */
function twoNodeChainGraph(): Graph {
  const node1: Node = {
    kind: "code",
    id: "node1",
    subGoal: "第一步",
    async execute() {
      return { nodeId: "node1", status: "ok", result: { passed: true, value: 10 } };
    },
  };
  const node2: Node = {
    kind: "code",
    id: "node2",
    subGoal: "第二步",
    async execute(_instance, input) {
      return {
        nodeId: "node2",
        status: "ok",
        result: { received: (input.data as any).value, doubled: (input.data as any).value * 2 },
      };
    },
  };

  const e1: Edge = {
    id: "to_node2",
    from: "node1",
    to: "node2",
    priority: 10,
    guard: (c) => c.status === "ok",
    migrate(_instance, completion) {
      return {
        frame: { nodeId: completion.nodeId, status: "ok", summary: "step1 done", result: completion.result },
        input: { value: (completion.result as any).value },
      };
    },
  };
  const e2: Edge = {
    id: "to_end",
    from: "node2",
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
    id: "two_node",
    goal: "双节点链式",
    entries: [{ id: "main", guard: () => true, startNodeId: "node1" }],
    nodes: { node1, node2 },
    routing: {
      node1: { nodeId: "node1", edges: [e1], router: { kind: "first-match" } },
      node2: { nodeId: "node2", edges: [e2], router: { kind: "first-match" } },
    },
  };
}

/** 带 agent node 的图（需要 LLM） */
function agentNodeGraph(): Graph {
  const agentNode: Node = {
    kind: "code",
    id: "agent_step",
    subGoal: "调用 agent 完成节点",
    tools: ["read"],
    async execute(_instance, _input, ctx) {
      return ctx.runAgent({
        prompt: 'You are in a graph node. Call __graph_complete__ with status="ok" and result={done:true}. Do nothing else.',
      });
    },
  };

  return {
    id: "agent_graph",
    goal: "agent 节点图",
    entries: [{ id: "main", guard: () => true, startNodeId: "agent_step" }],
    nodes: { agent_step: agentNode },
    routing: {
      agent_step: {
        nodeId: "agent_step",
        edges: [{
          id: "done",
          from: "agent_step",
          to: END,
          priority: 10,
          guard: () => true,
          migrate(_instance, completion) {
            return {
              frame: { nodeId: completion.nodeId, status: completion.status, summary: "agent done", result: completion.result },
            };
          },
        }],
        router: { kind: "first-match" },
      },
    },
  };
}

// ================================================================
//  测试
// ================================================================

describe("createIsolatedGraphSessionFactory", () => {
  it("创建工厂成功", () => {
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    expect(factory).toBeTypeOf("function");
  });

  it("工厂创建的 session 具有 run / abort / dispose", async () => {
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    expect(session.run).toBeTypeOf("function");
    expect(session.abort).toBeTypeOf("function");
    expect(session.dispose).toBeTypeOf("function");

    session.dispose();
  });
});

describe("纯代码节点图", () => {
  it("单节点纯代码图返回 GraphRunResult", async () => {
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const result = await session.run(pureCodeGraph(), delegateReq({ x: 1 }));

    expect(result.graphId).toBe("pure_code");
    expect(result.status).toBe("ok");
    expect(result.steps).toBe(1);

    session.dispose();
  });

  it("两节点链式图正确传递 input 并返回 END result", async () => {
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const result = await session.run(twoNodeChainGraph(), delegateReq());

    expect(result.status).toBe("ok");
    expect(result.steps).toBe(2);
    expect((result.result as any).doubled).toBe(20);
    expect((result.result as any).received).toBe(10);

    session.dispose();
  });

  it("max steps 100 触发时返回 failed", async () => {
    const selfLoopNode: Node = {
      kind: "code",
      id: "loop",
      subGoal: "自环",
      async execute() {
        return { nodeId: "loop", status: "ok", result: {} };
      },
    };

    const selfLoopGraph: Graph = {
      id: "loop_graph",
      goal: "死循环",
      entries: [{ id: "e", guard: () => true, startNodeId: "loop" }],
      nodes: { loop: selfLoopNode },
      routing: {
        loop: {
          nodeId: "loop",
          edges: [{
            id: "self",
            from: "loop",
            to: "loop",
            priority: 10,
            guard: () => true,
            migrate(_i, c) {
              return { frame: { nodeId: c.nodeId, status: "ok", summary: "looping", result: {} } };
            },
          }],
          router: { kind: "first-match" },
        },
      },
    };

    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const result = await session.run(selfLoopGraph, delegateReq());

    expect(result.status).toBe("failed");
    expect(result.steps).toBe(100);
    expect((result.result as any).reason).toContain("Max steps");

    session.dispose();
  });

  it("两次 run 之间的 frames 不串线", async () => {
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const r1 = await session.run(twoNodeChainGraph(), delegateReq());
    const r2 = await session.run(pureCodeGraph(), delegateReq());

    expect(r1.steps).toBe(2);
    expect(r2.steps).toBe(1);

    session.dispose();
  });

  it("graph 节点复用真实 Runtime 的 call 隔离与最终结果归约", async () => {
    const child = pureCodeGraph();
    const parent: Graph = {
      id: "parent_with_child",
      goal: "父图调用子图",
      entries: [{ id: "e", guard: () => true, startNodeId: "child_call" }],
      nodes: {
        child_call: {
          kind: "graph",
          id: "child_call",
          subGoal: "调用子图",
          graph: child,
        },
      },
      routing: {
        child_call: {
          nodeId: "child_call",
          edges: [{
            id: "done",
            from: "child_call",
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
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const result = await session.run(parent, delegateReq({ x: 3 }));

    expect(result).toMatchObject({
      graphId: "parent_with_child",
      status: "ok",
      steps: 1,
      result: { value: 3 },
    });
    expect(result.result).not.toHaveProperty("childFrames");
    session.dispose();
  });

  it("mechanism 与节点共享真实 AgentInstance.scratch", async () => {
    const graph = pureCodeGraph();
    graph.mechanisms = [{
      name: "prepare",
      async onNodeEnter(ctx) {
        ctx.instance.scratch.prepared = true;
      },
    }];
    graph.nodes.step1 = {
      kind: "code",
      id: "step1",
      subGoal: "读取 mechanism 状态",
      async execute(instance) {
        return {
          nodeId: "step1",
          status: "ok",
          result: { prepared: instance.scratch.prepared },
        };
      },
    };
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const result = await session.run(graph, delegateReq());

    expect(result.result).toEqual({ prepared: true });
    session.dispose();
  });

  it("runtime-only delegate session 在节点结束时关闭 mechanism scope", async () => {
    const graph = pureCodeGraph();
    let scope: any;
    let cleanupCount = 0;
    graph.mechanisms = [{
      name: "delegate-cleanup",
      onNodeEnter(ctx) {
        scope = ctx.scope;
        ctx.scope.onCleanup(() => { cleanupCount += 1; });
      },
    }];
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const result = await session.run(graph, delegateReq());

    expect(result.status).toBe("ok");
    expect(cleanupCount).toBe(1);
    expect(scope.isActive()).toBe(false);
    expect(scope.signal.aborted).toBe(true);
    session.dispose();
  });

  it("runtime-only delegate 的每次新 AgentInstance 都获得独立 mechanism state", async () => {
    const graph = pureCodeGraph();
    const seen: number[] = [];
    let createCount = 0;
    const mechanism: Mechanism<{ count: number }> = {
      name: "delegate-state",
      createState() {
        createCount += 1;
        return { count: 0 };
      },
      onNodeEnter(ctx) {
        ctx.state.count += 1;
        seen.push(ctx.state.count);
      },
    };
    graph.mechanisms = [mechanism];
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    await session.run(graph, delegateReq());
    await session.run(graph, delegateReq());

    expect(seen).toEqual([1, 1]);
    expect(createCount).toBe(2);
    session.dispose();
  });
});

describe("frameFormatter", () => {
  it("纯代码节点不触发 LLM context 投影，因此不调用 frameFormatter", async () => {
    const calls: any[] = [];
    const factory = createIsolatedGraphSessionFactory(factoryOptions({
      frameFormatter: (frames) => {
        calls.push([...frames]);
        return `CUSTOM: ${frames.length} frames`;
      },
    }));
    const session = await factory(delegateReq());

    await session.run(twoNodeChainGraph(), delegateReq());

    expect(calls).toHaveLength(0);
    session.dispose();
  });
});

describe("contextRenderer", () => {
  it("传播到 runtime-only 隔离 session 并在纯代码节点进入时执行", async () => {
    const renderer = vi.fn((input: any) => ({
      anchor: { content: `ISOLATED:${input.node.id}` },
    }));
    const factory = createIsolatedGraphSessionFactory(factoryOptions({ contextRenderer: renderer }));
    const session = await factory(delegateReq());
    try {
      await session.run(pureCodeGraph(), delegateReq({ x: 1 }));
      expect(renderer).toHaveBeenCalledTimes(1);
      expect(renderer.mock.calls[0][0]).toMatchObject({
        graph: { id: "pure_code", goal: "纯代码图" },
        node: { id: "step1", subGoal: "纯代码节点" },
        reason: "node-enter",
      });
    } finally {
      session.dispose();
    }
  });

  it("传播 skillProvider/skillRenderer 到 runtime-only 隔离 session", async () => {
    const provider = vi.fn(async () => "ISOLATED SKILL");
    const renderer = vi.fn(() => ({ kind: "skill" as const, content: "ISOLATED GUIDANCE" }));
    const graph = pureCodeGraph();
    (graph.nodes.step1 as Extract<Node, { kind: "code" }>).skill = "remote-skill";
    const factory = createIsolatedGraphSessionFactory(factoryOptions({
      skillProvider: provider,
      skillRenderer: renderer,
    }));
    const session = await factory(delegateReq());
    try {
      await session.run(graph, delegateReq());
      expect(provider).toHaveBeenCalledTimes(1);
      expect(renderer).toHaveBeenCalledWith("remote-skill", "ISOLATED SKILL", expect.any(Object));
    } finally {
      session.dispose();
    }
  });

  it("传播 Graph/Node renderer registry，并保持 Node 优先", async () => {
    const extensionRenderer = vi.fn(() => ({ anchor: { content: "EXT" } }));
    const graphRenderer = vi.fn(() => ({ anchor: { content: "GRAPH" } }));
    const nodeRenderer = vi.fn(() => ({ anchor: { content: "NODE" } }));
    const factory = createIsolatedGraphSessionFactory(factoryOptions({
      contextRenderer: extensionRenderer,
      contextRenderers: {
        graphs: { pure_code: graphRenderer },
        nodes: { pure_code: { step1: nodeRenderer } },
      },
    }));
    const session = await factory(delegateReq());
    try {
      await session.run(pureCodeGraph(), delegateReq());
      expect(nodeRenderer).toHaveBeenCalledTimes(1);
      expect(graphRenderer).not.toHaveBeenCalled();
      expect(extensionRenderer).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });
});

describe("agent 节点（需要 LLM）", () => {
  it("agent 节点调用 __graph_complete__ 后返回结果", async () => {
    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    try {
      const result = await session.run(agentNodeGraph(), delegateReq());

      expect(result.graphId).toBe("agent_graph");
      expect(result.status).toBe("ok");
      expect((result.result as any).done).toBe(true);
    } catch (err: any) {
      if (err.message?.includes("API key") || err.message?.includes("auth")) {
        // 预期内的失败
      } else {
        throw err;
      }
    } finally {
      session.dispose();
    }
  }, 60000);
});

describe("entry 匹配", () => {
  it("无匹配 entry 时返回 failed", async () => {
    const graph: Graph = {
      id: "no_entry",
      goal: "无匹配入口",
      entries: [{
        id: "only",
        guard: (bg) => (bg as any).role === "admin",
        startNodeId: "step1",
      }],
      nodes: {
        step1: {
          kind: "code",
          id: "step1",
          subGoal: "x",
          async execute() { return { nodeId: "step1", status: "ok", result: {} }; },
        },
      },
      routing: {
        step1: {
          nodeId: "step1",
          edges: [{
            id: "done", from: "step1", to: END, priority: 10,
            guard: () => true,
            migrate(_i, c) {
              return { frame: { nodeId: c.nodeId, status: c.status, summary: "x", result: {} } };
            },
          }],
          router: { kind: "first-match" },
        },
      },
    };

    const factory = createIsolatedGraphSessionFactory(factoryOptions());
    const session = await factory(delegateReq());

    const result = await session.run(graph, delegateReq({ role: "guest" }));

    expect(result.status).toBe("failed");
    expect((result.result as any).reason).toContain("无匹配入口");

    session.dispose();
  });
});
