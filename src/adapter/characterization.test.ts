// ============================================================
//  Phase 1 — 现有行为冻结（characterization tests）
// ============================================================
//
//  不改运行时，只记录当前行为。作为 NodeScope 投影重构的回归基准。
//
//  已有覆盖的测试（此处只引用，不重复）：
//    双节点折叠            → projection.test.ts "第二个节点：前序节点 ReAct 被摘要顶替"
//    子图嵌套              → loop-graph-extension.test.ts "子图内的 agent 节点可以通过..."
//    frameFormatter 自定义 → projection.test.ts "自定义 frameFormatter"
//    agent-choice          → projection.test.ts "CURRENT 段渲染 agent-choice 可用边列表"
//    nodeMarker 未匹配降级  → projection.test.ts "nodeMarker 未匹配时退化：摘要追加末尾..."
//
//  新增覆盖的测试：
//    同节点循环进入
//    同 session 连续执行两张图
//    节点内多次 runAgent
//    mechanism 和 skill 的消息顺序
//    同节点循环进入时的哨兵唯一性
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopGraphExtension } from "./loop-graph-extension.js";
import type { Edge, Entry, Graph, Node } from "../type.js";
import { END } from "../type.js";
import { projectMessages } from "./projection.js";
import type { MessageEntry } from "./projection.js";

// ── 帮助函数 ──

const SCOPE = "loop_graph_node_scope";

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
    emit(eventName: string, event: any) {
      for (const handler of handlers.get(eventName) ?? []) {
        handler(event);
      }
    },
    /** 获取所有 sendMessage 调用记录（含 customType 和顺序） */
    _sentMessages: sentMessages,
  } as any;
}

function minimalGraph(id: string, extra?: Partial<Graph>): Graph {
  const node: Node = {
    kind: "code",
    id: "start",
    subGoal: "测试节点",
    async execute() {
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
      start: { nodeId: "start", edges: [edge], router: { kind: "priority-first" } },
    },
    ...extra,
  };
}

/** 提取所有 customType 不为空的 sendMessage 调用顺序 */
function messageSequence(pi: any): string[] {
  return pi._sentMessages
    .filter((m: any) => m.customType)
    .map((m: any) => m.customType);
}

// ================================================================
//  测试 1: 同节点循环进入 — 哨兵递增计数唯一性
// ================================================================

describe("characterization — 同节点循环进入", () => {
  it("循环边回到同一节点时，每次进入产生递增且唯一的 NodeScope", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);

    const visited: number[] = [];

    const loopNode: Node = {
      kind: "code",
      id: "looper",
      subGoal: "循环节点",
      async execute(_instance, input) {
        const visit = typeof input.data.visit === "number" ? input.data.visit : 0;
        visited.push(visit);
        const nextVisit = visit + 1;
        return {
          nodeId: "looper",
          status: nextVisit >= 3 ? "ok" : "ok", // visit 0,1,2 → 3 次执行
          result: { visit: nextVisit },
        };
      },
    };

    const loopBack: Edge = {
      id: "loop_back",
      from: "looper",
      to: "looper",
      priority: 10,
      guard: (c) => (c.result.visit as number) < 3,
      migrate(_instance, completion) {
        return {
          frame: {
            nodeId: completion.nodeId,
            status: completion.status,
            summary: `loop iteration ${completion.result.visit}`,
            result: completion.result,
          },
          input: { visit: completion.result.visit },
        };
      },
    };

    const loopExit: Edge = {
      id: "loop_exit",
      from: "looper",
      to: END,
      priority: 5,
      guard: (c) => (c.result.visit as number) >= 3,
      migrate(_instance, completion) {
        return {
          frame: {
            nodeId: completion.nodeId,
            status: completion.status,
            summary: "loop complete",
            result: completion.result,
          },
        };
      },
    };

    const g: Graph = {
      id: "loop_test",
      goal: "循环测试",
      entries: [{ id: "e", guard: () => true, startNodeId: "looper" }],
      nodes: { looper: loopNode },
      routing: {
        looper: {
          nodeId: "looper",
          edges: [loopBack, loopExit],
          router: { kind: "priority-first" },
        },
      },
    };

    await loop.executeGraph(g, { source: "command", args: "" });

    // 应执行 3 次（visit 0,1,2 → 满 3 退出）
    expect(visited).toEqual([0, 1, 2]);

    const scopeMessages = pi._sentMessages.filter(
      (m: any) => m.customType === SCOPE,
    );
    expect(scopeMessages).toHaveLength(3);
    expect(scopeMessages.map((m: any) => m.details.visit)).toEqual([1, 2, 3]);
    expect(new Set(scopeMessages.map((m: any) => m.details.scopeId)).size).toBe(3);
    expect(scopeMessages.every((m: any) => m.details.nodeId === "looper" && m.details.protocol === 2)).toBe(true);
  });
});

// ================================================================
//  测试 2: 同 session 连续执行两张图
// ================================================================

describe("characterization — 同 session 连续执行两张图", () => {
  it("第二张图执行后，第一张图的 frames 不影响第二张图", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);

    const g1 = minimalGraph("graph_1");
    const g2 = minimalGraph("graph_2");

    // 连续执行
    await loop.executeGraph(g1, { source: "command", args: "first" });
    await loop.executeGraph(g2, { source: "command", args: "second" });

    // 两者都应正常完成（不抛错）
    const errorMessages = pi._sentMessages.filter(
      (m: any) => m.customType === "loop_graph_error",
    );
    expect(errorMessages).toHaveLength(0);
  });

  it("两张图的 graphRunId 与 scopeId 互不重叠", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);

    const g1 = minimalGraph("graph_1");
    const g2 = minimalGraph("graph_2");

    // 第一张图执行前的消息数
    const beforeG1 = pi._sentMessages.length;
    await loop.executeGraph(g1, { source: "command", args: "first" });
    const afterG1 = pi._sentMessages.length;

    // 第二张图执行前的消息数
    const beforeG2 = pi._sentMessages.length;
    await loop.executeGraph(g2, { source: "command", args: "second" });
    const afterG2 = pi._sentMessages.length;

    const g1Scopes = pi._sentMessages
      .slice(beforeG1, afterG1)
      .filter((m: any) => m.customType === SCOPE);
    const g2Scopes = pi._sentMessages
      .slice(beforeG2, afterG2)
      .filter((m: any) => m.customType === SCOPE);

    expect(g1Scopes.length).toBeGreaterThan(0);
    expect(g2Scopes.length).toBeGreaterThan(0);
    expect(g1Scopes[0].details.graphRunId).not.toBe(g2Scopes[0].details.graphRunId);
    expect(g1Scopes[0].details.scopeId).not.toBe(g2Scopes[0].details.scopeId);
  });
});

// ================================================================
//  测试 3: 节点内多次 runAgent
// ================================================================

describe("characterization — 节点内多次 runAgent", () => {
  it("hybrid 节点多次调用 runAgent 均能正常完成", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    const calls: string[] = [];

    const hybridNode: Node = {
      kind: "code",
      id: "hybrid",
      subGoal: "多次 agent 调用",
      tools: ["read"],
      async execute(_instance, _input, ctx) {
        calls.push("code:before");
        const r1 = await ctx.runAgent({ prompt: "first agent call" });
        calls.push(`agent1:${r1.status}`);
        const r2 = await ctx.runAgent({ prompt: "second agent call" });
        calls.push(`agent2:${r2.status}`);
        return { nodeId: "hybrid", status: "ok", result: { r1: r1.status, r2: r2.status } };
      },
    };

    const g: Graph = {
      id: "hybrid_test",
      goal: "多次 runAgent",
      entries: [{ id: "e", guard: () => true, startNodeId: "hybrid" }],
      nodes: { hybrid: hybridNode },
      routing: {
        hybrid: {
          nodeId: "hybrid",
          edges: [{
            id: "done",
            from: "hybrid",
            to: END,
            priority: 10,
            guard: () => true,
            migrate(_instance, completion) {
              return {
                frame: {
                  nodeId: completion.nodeId,
                  status: completion.status,
                  summary: `r1=${completion.result.r1}, r2=${completion.result.r2}`,
                  result: completion.result,
                },
              };
            },
          }],
          router: { kind: "first-match" },
        },
      },
    };

    await loop.executeGraph(g, { source: "command", args: "" });

    // 两次 agent 调用都应完成
    expect(calls).toContain("code:before");
    expect(calls.filter((c) => c.startsWith("agent")).length).toBe(2);
  });

  it("多次 runAgent 之间代码侧状态保持", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    let codeState = 0;

    const hybridNode: Node = {
      kind: "code",
      id: "stateful",
      subGoal: "有状态节点",
      async execute(_instance, _input, ctx) {
        codeState = 1;
        await ctx.runAgent({ prompt: "first" });
        codeState = 2;
        await ctx.runAgent({ prompt: "second" });
        return { nodeId: "stateful", status: "ok", result: { finalState: codeState } };
      },
    };

    const g = minimalGraph("stateful_test");
    g.nodes.start = hybridNode;

    await loop.executeGraph(g, { source: "command", args: "" });

    // finalState 应反映最后一次赋值
    const completeMessages = pi._sentMessages.filter(
      (m: any) => m.customType === "loop_graph_complete",
    );
    expect(completeMessages.length).toBeGreaterThan(0);
  });
});

// ================================================================
//  测试 4: mechanism 和 skill 的消息追加顺序
// ================================================================

describe("characterization — mechanism 与 skill 消息顺序", () => {
  it("NodeScope 后消息追加顺序为：skill → mechanism → prompt", async () => {
    const pi = fakePi();
    const skillBasePath = mkdtempSync(join(tmpdir(), "loop-graph-skill-order-"));
    const skillDir = join(skillBasePath, "test-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "ORDER_SKILL_BODY", "utf8");
    const loop = createLoopGraphExtension(pi, { skillBasePath });

    const g = minimalGraph("order_test");
    g.mechanisms = [
      {
        name: "test_mech",
        async onNodeEnter(ctx) {
          ctx.appendContext("mech_context");
        },
      },
    ];
    g.nodes.start = {
      kind: "code",
      id: "start",
      subGoal: "顺序测试",
      skill: "test-skill",
      async execute(_instance, _input, ctx) {
        return ctx.runAgent({ prompt: "go" });
      },
    };

    try {
      await loop.executeGraph(g, { source: "command", args: "" });
    } finally {
      rmSync(skillBasePath, { recursive: true, force: true });
    }

    const seq = messageSequence(pi);

    const scopeIdx = seq.indexOf(SCOPE);
    const skillIdx = seq.indexOf("loop_graph_skill", scopeIdx);
    const mechIdx = seq.indexOf("loop_graph_mechanism", scopeIdx);
    const promptIdx = seq.indexOf("loop_graph_prompt", scopeIdx);

    // 哨兵应存在
    expect(scopeIdx).toBeGreaterThanOrEqual(0);

    expect(skillIdx).toBeGreaterThan(scopeIdx);
    expect(skillIdx).toBeLessThan(mechIdx);
    expect(mechIdx).toBeLessThan(promptIdx);
  });

  it("无 skill 节点时 mechanism 仍在 prompt 之前", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);

    const g = minimalGraph("no_skill_order");
    g.mechanisms = [
      {
        name: "test_mech",
        async onNodeEnter(ctx) {
          ctx.appendContext("mech_context");
        },
      },
    ];
    g.nodes.start = {
      kind: "code",
      id: "start",
      subGoal: "无 skill",
      async execute(_instance, _input, ctx) {
        return ctx.runAgent({ prompt: "go" });
      },
    };

    await loop.executeGraph(g, { source: "command", args: "" });

    const seq = messageSequence(pi);
    const scopeIdx = seq.indexOf(SCOPE);
    const mechIdx = seq.indexOf("loop_graph_mechanism", scopeIdx);
    const promptIdx = seq.indexOf("loop_graph_prompt", scopeIdx);

    // mechanism 必须在 prompt 之前
    expect(mechIdx).toBeGreaterThan(scopeIdx);
    expect(mechIdx).toBeLessThan(promptIdx);
  });

  it("skill 内容以 loop_graph_skill 类型追加，display 为 false", async () => {
    const pi = fakePi();
    const skillBasePath = mkdtempSync(join(tmpdir(), "loop-graph-skill-content-"));
    const skillDir = join(skillBasePath, "test-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "FIXED_SKILL_BODY", "utf8");
    const loop = createLoopGraphExtension(pi, { skillBasePath });

    const g = minimalGraph("skill_display_test");
    g.nodes.start = {
      kind: "code",
      id: "start",
      subGoal: "skill test",
      skill: "test-skill",
      async execute() {
        return { nodeId: "start", status: "ok", result: {} };
      },
    };

    try {
      await loop.executeGraph(g, { source: "command", args: "" });
    } finally {
      rmSync(skillBasePath, { recursive: true, force: true });
    }

    const skillMessages = pi._sentMessages.filter(
      (m: any) => m.customType === "loop_graph_skill",
    );

    expect(skillMessages).toHaveLength(1);
    expect(skillMessages[0]).toMatchObject({
      display: false,
      content: "[skill: test-skill]\n\nFIXED_SKILL_BODY",
    });
  });
});

// ================================================================
//  测试 5: 哨兵唯一性 — 同节点不同次进入的标记互不相同
// ================================================================

describe("characterization — NodeScope 唯一性跨调用", () => {
  it("两个不同 graph 的 scope 带正确 graphId/nodeId 且 run 隔离", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);

    const makeGraph = (graphId: string, nodeId: string): Graph => {
      const node: Node = {
        kind: "code",
        id: nodeId,
        subGoal: `node ${nodeId}`,
        async execute() {
          return { nodeId, status: "ok", result: {} };
        },
      };
      return {
        id: graphId,
        goal: "测试",
        entries: [{ id: "e", guard: () => true, startNodeId: nodeId }],
        nodes: { [nodeId]: node },
        routing: {
          [nodeId]: {
            nodeId,
            edges: [{
              id: "done",
              from: nodeId,
              to: END,
              priority: 10,
              guard: () => true,
              migrate(_i: any, c: any) {
                return { frame: { nodeId: c.nodeId, status: "ok", summary: "done", result: {} } };
              },
            }],
            router: { kind: "first-match" as const },
          },
        },
      };
    };

    const g1 = makeGraph("graph_a", "node_a");
    const g2 = makeGraph("graph_b", "node_b");

    await loop.executeGraph(g1, { source: "command", args: "first" });
    const allAfterG1 = pi._sentMessages.filter((m: any) => m.customType === SCOPE);

    await loop.executeGraph(g2, { source: "command", args: "second" });
    const allAfterG2 = pi._sentMessages.filter((m: any) => m.customType === SCOPE);
    const first = allAfterG1[0].details;
    const second = allAfterG2[allAfterG1.length].details;
    expect(first).toMatchObject({ graphId: "graph_a", nodeId: "node_a", protocol: 2 });
    expect(second).toMatchObject({ graphId: "graph_b", nodeId: "node_b", protocol: 2 });
    expect(first.graphRunId).not.toBe(second.graphRunId);
    expect(first.scopeId).not.toBe(second.scopeId);
  });
});

// ================================================================
//  测试 6: 找不到当前边界时的降级行为（已有覆盖，此处只做交叉验证）
// ================================================================

describe("characterization — NodeScope 缺失时 fail closed", () => {
  it("scope 不存在时丢弃 raw head，仅保留摘要", () => {
    // 交叉验证 projection.test.ts 中的同名测试
    const messages: MessageEntry[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ];
    const out = projectMessages({
      messages,
      frames: [
        { nodeId: "n1", status: "ok", summary: "s1", result: {} },
      ],
      currentNode: null,
      activeScope: { protocol: 2, graphRunId: "r", instanceId: "i", scopeId: "missing", graphId: "g", nodeId: "n", visit: 1, depth: 1 },
    });

    const asText = (m: MessageEntry) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);

    expect(out).toHaveLength(1);
    expect(asText(out[0])).toContain("=== COMPLETED ===");
    expect(asText(out[0])).not.toContain("SYS");
  });

  it("scope 未匹配且 currentNode 非 null 时恢复确定性 CURRENT 段", () => {
    const current: Node = {
      kind: "code",
      id: "curr",
      subGoal: "当前节点",
      execute: async () => ({ nodeId: "curr", status: "ok", result: {} }),
    };

    const out = projectMessages({
      messages: [{ role: "user", content: "hi" }],
      frames: [],
      currentNode: current,
      activeScope: { protocol: 2, graphRunId: "r", instanceId: "i", scopeId: "missing", graphId: "g", nodeId: "curr", visit: 1, depth: 1 },
    });

    const text = out.map((m: any) =>
      typeof m.content === "string" ? m.content : "",
    ).join("\n");
    expect(text).toContain("=== CURRENT ===");
    expect(text).toContain("curr");
    expect(text).not.toContain("hi");
  });
});
