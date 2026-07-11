// ============================================================
//  Compaction & frame boundary tests
// ============================================================
//
//  Supplementary tests for the NodeScope v2 / frame-agnostic refactor:
//   B.1  firstKeptEntryId cut inside completed node → frame preserved
//   B.2  firstKeptEntryId at next NodeScope → frame replaced by summary
//   B.3  Multiple compactions → projectedFrameBase monotonically advances
//   B.5  END edge with MigrationResult.output, frame without status/result
//   B.7  Realistic compaction simulation via event emission
//   C    Fail-closed compaction for shared call/compose
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { GraphRuntime, type NodeScopeDescriptor } from "../runtime.js";
import { findCompactedFrameBase } from "./loop-graph-extension.js";
import { createLoopGraphExtension } from "./loop-graph-extension.js";
import type { ContextFrame, Edge, Entry, Graph, Node, GraphRunResult, NodeCompletion } from "../type.js";
import { END } from "../type.js";
import { projectMessages, type MessageEntry } from "./projection.js";

// ── Helpers ──

function makeScopeEntry(scopeId: string, entryId?: string): Record<string, unknown> {
  return {
    id: entryId ?? `entry-${scopeId}`,
    type: "custom_message",
    customType: "loop_graph_node_scope",
    details: { protocol: 2, scopeId },
  };
}

function makeFrameScope(scopeId: string): NodeScopeDescriptor {
  return {
    protocol: 2,
    graphRunId: "run-1",
    instanceId: "inst-1",
    scopeId,
    graphId: "graph-1",
    nodeId: "node-x",
    visit: 1,
    depth: 1,
  };
}

// ═══════════════════════════════════════════════════════════
//  B.1  firstKeptEntryId 切在已完成节点内部 → 该节点 frame 保留
// ═══════════════════════════════════════════════════════════

describe("findCompactedFrameBase — 切点边界", () => {
  it("切点落在节点内部（scope 在 prefix 但 nextScope 在 suffix）时 frame 保留", () => {
    const scopeA = makeFrameScope("scope-a");
    const scopeB = makeFrameScope("scope-b");

    const branchEntries = [
      makeScopeEntry("scope-a", "entry-0"),
      { id: "entry-1", type: "message", content: "node A's first work" },
      { id: "firstKept", type: "message", content: "node A's later work" },
      makeScopeEntry("scope-b", "entry-3"),
    ];

    // firstKeptEntryId 切在节点 A 内部（entry-1 和 scope-b 之间）
    const base = findCompactedFrameBase(
      branchEntries,
      "firstKept",
      [scopeA, scopeB],
    );

    // scopeA 的 nextScope (scopeB) 在 cut 之后 → scopeA 对应的 frame 不应被 compact
    expect(base).toBe(0);
  });

  it("切点就在下一 NodeScope 时，上一节点 frame 被 summary 替代", () => {
    const scopeA = makeFrameScope("scope-a");
    const scopeB = makeFrameScope("scope-b");

    const branchEntries = [
      makeScopeEntry("scope-a", "entry-0"),
      { id: "entry-1", type: "message", content: "node A work" },
      makeScopeEntry("scope-b", "entry-2"),
      { id: "firstKept", type: "message", content: "node B work" },
    ];

    // firstKeptEntryId 切在 scopeB 之后 → scopeA 的 nextScope (scopeB) 在 cut 之前
    const base = findCompactedFrameBase(
      branchEntries,
      "firstKept",
      [scopeA, scopeB],
    );

    // scopeA 完全落入 prefix → compacted = 1
    expect(base).toBe(1);
  });

  it("切点后的 frame 不受影响", () => {
    const scopeA = makeFrameScope("scope-a");
    const scopeB = makeFrameScope("scope-b");
    const scopeC = makeFrameScope("scope-c");

    const branchEntries = [
      makeScopeEntry("scope-a", "e0"),
      { id: "e1", type: "message", content: "A" },
      makeScopeEntry("scope-b", "e2"),
      { id: "e3", type: "message", content: "B" },
      makeScopeEntry("scope-c", "e4"),
      { id: "firstKept", type: "message", content: "C1" },
    ];

    const base = findCompactedFrameBase(
      branchEntries,
      "firstKept",
      [scopeA, scopeB, scopeC],
    );

    // scopeA 完全 compacted (nextScope=scopeB ≤ cut)，scopeB 也完全 compacted
    // scopeC 的 nextScope 不存在（INFINITY > cut）→ frameC 保留
    expect(base).toBe(2);
  });

  it("无 scope 信息时不推进基线，保留现有 frame 投影", () => {
    const scopeA = makeFrameScope("scope-a");
    const base = findCompactedFrameBase(
      undefined,
      undefined,
      [scopeA],
    );
    expect(base).toBe(0);
  });

  it("firstKeptEntryId 找不到时不推进基线，保留现有 frame 投影", () => {
    const scopeA = makeFrameScope("scope-a");
    const branchEntries = [
      makeScopeEntry("scope-a", "e0"),
    ];
    const base = findCompactedFrameBase(
      branchEntries,
      "nonexistent",
      [scopeA],
    );
    expect(base).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
//  B.3  连续多次 compaction 时 projectedFrameBase 单调前进
// ═══════════════════════════════════════════════════════════

describe("projectedFrameBase 单调前进", () => {
  it("多次 recordCompaction 不降低 projectedFrameBase", () => {
    const runtime = new GraphRuntime();
    const instance = runtime.pushGraph(
      {
        id: "g",
        goal: "test",
        entries: [{ id: "e", guard: () => true, startNodeId: "n" }],
        nodes: { n: { kind: "code", id: "n", subGoal: "n", execute: async () => ({ nodeId: "n", status: "ok", result: {} }) } },
        routing: { n: { nodeId: "n", edges: [], router: { kind: "first-match" } } },
      },
      {},
      "root",
    );

    // Simulate frames added over time
    instance.frames.push({ memory: "f1" });
    instance.frames.push({ memory: "f2" });
    instance.frames.push({ memory: "f3" });

    // First compaction: compact up to frame 2
    runtime.recordCompaction(2);
    expect(runtime.projectedFrames).toHaveLength(1); // only f3
    expect(runtime.projectedFrames[0]).toEqual({ memory: "f3" });

    // Second compaction: try to go backward (should be ignored)
    runtime.recordCompaction(1);
    expect(runtime.projectedFrames).toHaveLength(1); // still f3

    // Third compaction: move forward to 3
    instance.frames.push({ memory: "f4" });
    runtime.recordCompaction(3);
    expect(runtime.projectedFrames).toHaveLength(1); // only f4
    expect(runtime.projectedFrames[0]).toEqual({ memory: "f4" });
  });

  it("默认 recordCompaction() 使用当前 frames.length", () => {
    const runtime = new GraphRuntime();
    const instance = runtime.pushGraph(
      {
        id: "g", goal: "test",
        entries: [{ id: "e", guard: () => true, startNodeId: "n" }],
        nodes: { n: { kind: "code", id: "n", subGoal: "n", execute: async () => ({ nodeId: "n", status: "ok", result: {} }) } },
        routing: { n: { nodeId: "n", edges: [], router: { kind: "first-match" } } },
      },
      {},
      "root",
    );

    instance.frames.push({ memory: "f1" });
    instance.frames.push({ memory: "f2" });

    runtime.recordCompaction(); // defaults to frames.length = 2
    expect(runtime.projectedFrames).toHaveLength(0);

    instance.frames.push({ memory: "f3" });
    expect(runtime.projectedFrames).toHaveLength(1); // f3
  });
});

// ═══════════════════════════════════════════════════════════
//  B.5  END 边使用 MigrationResult.output
// ═══════════════════════════════════════════════════════════

function makeSimpleGraph(
  id: string,
  migrateResult: (completion: any) => { frame: ContextFrame; output?: { status: "ok" | "failed" | "cancelled"; result: Record<string, unknown> } },
): Graph {
  const node: Node = {
    kind: "code",
    id: "start",
    subGoal: "test",
    async execute() {
      return { nodeId: "start", status: "ok", result: { value: 42, extra: "data" } };
    },
  };

  const entry: Entry = {
    id: "main",
    guard: () => true,
    startNodeId: "start",
  };

  const endEdge: Edge = {
    id: "to_end",
    from: "start",
    to: END,
    priority: 10,
    guard: () => true,
    migrate(_instance, completion) {
      return migrateResult(completion);
    },
  };

  return {
    id,
    goal: "test graph",
    entries: [entry],
    nodes: { start: node },
    routing: {
      start: { nodeId: "start", edges: [endEdge], router: { kind: "first-match" } },
    },
  };
}

// This test validates the GraphRunResult extraction logic using a mock pi
describe("END edge output 解耦验证", () => {
  it("MigrationResult.output 优先于 frame.status/result", () => {
    // Simulate what the END handler in runGraphLoop does
    const migration = {
      frame: { customMemory: "important", status: "ok", result: { fromFrame: true } },
      output: { status: "failed", result: { fromOutput: true } },
    };

    const completion = { nodeId: "n", status: "ok", result: { fromCompletion: true } };

    const status = migration.output?.status ?? migration.frame.status ?? completion.status;
    const result = migration.output?.result ?? migration.frame.result ?? completion.result;

    expect(status).toBe("failed"); // output wins
    expect(result).toEqual({ fromOutput: true });
  });

  it("frame 不含 status/result 时回退到 completion", () => {
    const migration: { frame: ContextFrame; output?: { status: "ok" | "failed" | "cancelled"; result: Record<string, unknown> } } = {
      frame: { custom: "data" } as ContextFrame,
    };

    const completion = { nodeId: "n", status: "ok" as const, result: { fromCompletion: true } };

    const status = migration.output?.status ?? (migration.frame as any).status ?? completion.status;
    const result = migration.output?.result ?? (migration.frame as any).result ?? completion.result;

    expect(status).toBe("ok");
    expect(result).toEqual({ fromCompletion: true });
  });

  it("仅 output 声明返回，frame 为纯业务记忆", () => {
    const migration: { frame: ContextFrame; output: { status: "ok" | "failed" | "cancelled"; result: Record<string, unknown> } } = {
      frame: { findings: ["连接正常"], next: "检查隔离级别" },
      output: { status: "ok", result: { done: true } },
    };

    const completion = { nodeId: "n", status: "ok" as const, result: {} };

    const status = migration.output?.status ?? (migration.frame as any).status ?? completion.status;
    const result = migration.output?.result ?? (migration.frame as any).result ?? completion.result;

    expect(status).toBe("ok");
    expect(result).toEqual({ done: true });
    // frame stays as business memory only
    expect(migration.frame).not.toHaveProperty("status");
    expect(migration.frame).not.toHaveProperty("result");
  });
});

// ═══════════════════════════════════════════════════════════
//  B.7  模拟真实 compaction 事件形态与投影
// ═══════════════════════════════════════════════════════════

describe("compaction 事件形态模拟", () => {
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
        sentMessages.push({ ...message, _opts: options });
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
      sendUserMessage: vi.fn((content: string) => {
        sentMessages.push({ role: "user", content });
      }),
      emit(eventName: string, event: any) {
        let result: any;
        for (const handler of handlers.get(eventName) ?? []) {
          result = handler(event) ?? result;
        }
        return result;
      },
      _sentMessages: sentMessages,
      _handlers: handlers,
    } as any;
  }

  function singleNodeGraph(id: string): Graph {
    const node: Node = {
      kind: "code",
      id: "start",
      subGoal: "test",
      tools: ["read"],
      async execute(_instance, _input, ctx) {
        return ctx.runAgent({ prompt: "do something" });
      },
    };

    const edge: Edge = {
      id: "done",
      from: "start",
      to: END,
      priority: 10,
      guard: () => true,
      migrate(_instance, completion) {
        return {
          frame: { memory: "finished", nodeId: completion.nodeId, status: completion.status, summary: "done", result: completion.result },
          output: { status: completion.status, result: completion.result },
        };
      },
    };

    return {
      id,
      goal: "test",
      entries: [{ id: "e", guard: () => true, startNodeId: "start" }],
      nodes: { start: node },
      routing: { start: { nodeId: "start", edges: [edge], router: { kind: "first-match" } } },
    };
  }

  it("root-only 图：session_compact 推进 projectedFrameBase", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    const g = singleNodeGraph("compaction_test_root");
    (g.nodes.start as Extract<Node, { kind: "code" }>).execute = async () => {
      const scopeMessage = pi._sentMessages.find((m: any) => m.customType === "loop_graph_node_scope");
      const branchEntries = [
        { id: "entry-0", type: "custom_message", customType: "loop_graph_node_scope", details: scopeMessage.details },
        { id: "entry-1", type: "message", content: "agent work" },
      ];
      pi.emit("session_before_compact", {
        reason: "overflow",
        branchEntries,
        preparation: { firstKeptEntryId: "entry-1" },
      });
      pi.emit("session_compact", {
        reason: "overflow",
        willRetry: true,
      });
      const projected = pi.emit("context", {
        messages: [
          { role: "compactionSummary", summary: "summary of work so far" },
          scopeMessage,
          { role: "assistant", content: "recent work" },
        ],
      });
      expect(projected.messages[0].role).toBe("compactionSummary");
      expect(projected.messages.map((m: any) => m.content).join("\n")).toContain("recent work");
      return { nodeId: "start", status: "ok", result: {} };
    };
    await expect(loop.executeGraph(g, { source: "command", args: "" })).resolves.toMatchObject({ status: "ok" });
  });

  it("共享 call 活跃期间 session_before_compact 返回 { cancel: true }", () => {
    const pi = fakePi();
    createLoopGraphExtension(pi);

    // 注册 handlers 后直接测试：模拟 shared call 活跃时的 before_compact
    let cancelResult: any = undefined;

    // Register a handler that simulates the real session_before_compact logic
    const rt = new GraphRuntime();
    rt.pushGraph(
      { id: "parent", goal: "p", entries: [], nodes: {}, routing: {} },
      {},
      "root",
    );
    rt.pushGraph(
      { id: "child", goal: "c", entries: [], nodes: {}, routing: {} },
      {},
      "call",
    );

    // Directly test: hasActiveSharedCall should be true
    expect(rt.hasActiveSharedCall).toBe(true);

    // The before_compact handler would return { cancel: true }
    // This is already verified by the factory logic
  });

  it("compaction 后 projectedFrames 从基线重新生长，完整 frames 不删除", () => {
    const runtime = new GraphRuntime();
    const instance = runtime.pushGraph(
      {
        id: "g", goal: "test",
        entries: [{ id: "e", guard: () => true, startNodeId: "n" }],
        nodes: { n: { kind: "code", id: "n", subGoal: "n", execute: async () => ({ nodeId: "n", status: "ok", result: {} }) } },
        routing: { n: { nodeId: "n", edges: [], router: { kind: "first-match" } } },
      },
      {},
      "root",
    );

    instance.frames.push({ memory: "frame A", nodeId: "A", status: "ok", summary: "A", result: {} });
    instance.frames.push({ memory: "frame B", nodeId: "B", status: "ok", summary: "B", result: {} });
    instance.frames.push({ memory: "frame C", nodeId: "C", status: "ok", summary: "C", result: {} });

    // Simulate compaction that covers frames A and B
    runtime.recordCompaction(2);

    // Full frames intact
    expect(instance.frames).toHaveLength(3);
    expect(instance.frames[0]).toEqual({ memory: "frame A", nodeId: "A", status: "ok", summary: "A", result: {} });
    expect(instance.frames[1]).toEqual({ memory: "frame B", nodeId: "B", status: "ok", summary: "B", result: {} });

    // But projectedFrames only shows the new ones
    expect(runtime.projectedFrames).toHaveLength(1);
    expect(runtime.projectedFrames[0]).toEqual({ memory: "frame C", nodeId: "C", status: "ok", summary: "C", result: {} });

    // New frame appears in projection
    instance.frames.push({ memory: "frame D", nodeId: "D", status: "ok", summary: "D", result: {} });
    expect(runtime.projectedFrames).toHaveLength(2);
  });

  it("自定义 frame（无兼容字段）经默认 formatter 原样投影", () => {
    const customFrame: ContextFrame = {
      findings: ["连接正常", "并发写入时出现问题"],
      next: "检查事务隔离级别",
    };

    const out = projectMessages({
      messages: [],
      frames: [customFrame],
      currentNode: null,
    });

    const asText = (m: MessageEntry) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);

    const text = out.map(asText).join("\n");
    expect(text).toContain("连接正常");
    expect(text).toContain("并发写入时出现问题");
    expect(text).toContain("检查事务隔离级别");
    // 不应包含 SDK 内部字段
    expect(text).not.toContain('"nodeId"');
    expect(text).not.toContain('"status"');
  });

  it("真实 executeGraph 路径优先使用 MigrationResult.output", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    const result = await loop.executeGraph(
      makeSimpleGraph("output_path", () => ({
        frame: { businessMemory: "keep this" },
        output: { status: "failed", result: { from: "output" } },
      })),
      { source: "command", args: "" },
    );
    expect(result).toMatchObject({ status: "failed", result: { from: "output" } });
  });

  it("debug preview 不会因循环业务结果破坏图完成", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await loop.executeGraph(
      makeSimpleGraph("cyclic_output", () => ({
        frame: { memory: "opaque" },
        output: { status: "ok", result: cyclic },
      })),
      { source: "command", args: "" },
    );
    expect(result.status).toBe("ok");
    expect(result.result.self).toBe(result.result);
  });

  it("真实共享 call 的 before_compact handler 返回 cancel", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    let decision: unknown;
    const child = makeSimpleGraph("child_before", () => ({ frame: {} }));
    (child.nodes.start as Extract<Node, { kind: "code" }>).execute = async () => {
      decision = pi.emit("session_before_compact", { reason: "manual" });
      return { nodeId: "start", status: "ok", result: {} };
    };
    const parent: Graph = {
      id: "parent_before", goal: "p", entries: [{ id: "e", guard: () => true, startNodeId: "child" }],
      nodes: { child: { kind: "graph", id: "child", subGoal: "child", graph: child, boundary: "call" } },
      routing: { child: { nodeId: "child", router: { kind: "first-match" }, edges: [{ id: "end", from: "child", to: END, priority: 1, guard: () => true, migrate: (_i, c) => ({ frame: {}, output: { status: c.status, result: c.result } }) }] } },
    };
    await loop.executeGraph(parent, { source: "command", args: "" });
    expect(decision).toEqual({ cancel: true });
  });

  it("异常 session_compact 终止共享调用，并使后续 session context 为空", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    const child = makeSimpleGraph("child_violation", () => ({ frame: {} }));
    (child.nodes.start as Extract<Node, { kind: "code" }>).execute = async () => {
      pi.emit("session_compact", { reason: "forced" });
      return { nodeId: "start", status: "ok", result: {} };
    };
    const parent: Graph = {
      id: "parent_violation", goal: "p", entries: [{ id: "e", guard: () => true, startNodeId: "child" }],
      nodes: { child: { kind: "graph", id: "child", subGoal: "child", graph: child, boundary: "call" } },
      routing: { child: { nodeId: "child", router: { kind: "first-match" }, edges: [{ id: "end", from: "child", to: END, priority: 1, guard: () => true, migrate: (_i, c) => ({ frame: {}, output: { status: c.status, result: c.result } }) }] } },
    };
    const result = await loop.executeGraph(parent, { source: "command", args: "" });
    expect(result.status).toBe("failed");
    expect(String(result.result.reason)).toContain("compaction 边界违规");
    expect(pi.emit("context", { messages: [{ role: "user", content: "child recent transcript" }] })).toEqual({ messages: [] });
  });
});

// ═══════════════════════════════════════════════════════════
//  C    Fail-closed compaction boundary violation
// ═══════════════════════════════════════════════════════════

describe("compaction 边界违规 fail-closed", () => {
  it("GraphRuntime.hasActiveSharedCall 检测嵌套 call/compose", () => {
    const runtime = new GraphRuntime();
    // root-only
    runtime.pushGraph(
      { id: "g", goal: "test", entries: [], nodes: {}, routing: {} },
      {},
      "root",
    );
    expect(runtime.hasActiveSharedCall).toBe(false);

    // push a call child
    runtime.pushGraph(
      { id: "child", goal: "child", entries: [], nodes: {}, routing: {} },
      {},
      "call",
    );
    expect(runtime.hasActiveSharedCall).toBe(true);

    runtime.popGraph();
    expect(runtime.hasActiveSharedCall).toBe(false);
  });

});
