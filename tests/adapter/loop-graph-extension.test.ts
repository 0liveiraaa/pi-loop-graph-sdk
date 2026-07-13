// ============================================================
//  loop-graph-extension 工厂测试
// ============================================================

import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopGraphExtension } from "../../src/adapter/loop-graph-extension.js";
import type { LoopGraphExtension } from "../../src/adapter/loop-graph-extension.js";
import { debugLog } from "../../src/adapter/debug-log.js";
import type { Graph, Edge, Entry, Mechanism, Node } from "../../src/type.js";
import { END } from "../../src/type.js";

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
    getAllTools: vi.fn(() => [
      {
        name: "read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      { name: "__graph_complete__", parameters: { type: "object", properties: {} } },
    ]),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
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
        const candidate = handler(event);
        // 同步 characterization 只观察同步 patch；异步事件用 emitAsync。
        // pi 会 await handler，并忽略返回 undefined 的观察器。
        if (!(candidate instanceof Promise) && candidate !== undefined) result = candidate;
      }
      return result;
    },
    async emitAsync(eventName: string, event: any) {
      const results: unknown[] = [];
      for (const handler of handlers.get(eventName) ?? []) {
        results.push(await handler(event));
      }
      return results;
    },
    _handlerCount(eventName: string) {
      return (handlers.get(eventName) ?? []).length;
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
  describe("Phase 3 renderer 分层覆盖", () => {
    const renderer = (label: string) => () => ({ anchor: { content: label } });

    it("按 Node > Graph > Extension 选择 renderer，调用级 override 最高", async () => {
      const pi = fakePi();
      const seen: Record<string, string> = {};
      const makeNode = (id: string): Node => ({
        kind: "code", id, subGoal: id,
        async execute() {
          const projected = pi.emit("context", { messages: [...pi._sentMessages] });
          const scope = projected.messages.find((message: any) =>
            message.customType === "loop_graph_node_scope" && message.details?.nodeId === id);
          seen[id] = String(scope?.content);
          return { nodeId: id, status: "ok", result: {} };
        },
      });
      const graph: Graph = {
        id: "phase3_graph", goal: "phase3",
        entries: [{ id: "entry", guard: () => true, startNodeId: "a" }],
        nodes: { a: makeNode("a"), b: makeNode("b") },
        routing: {
          a: { nodeId: "a", router: { kind: "first-match" }, edges: [edgeToNext("a", "b")] },
          b: { nodeId: "b", router: { kind: "first-match" }, edges: [edgeToEnd("b")] },
        },
      };
      const extGraph = terminalGraph("extension_fallback", makeNode("ext"));
      const loop = createLoopGraphExtension(pi, {
        contextRenderer: renderer("EXTENSION"),
        contextRenderers: {
          graphs: { phase3_graph: renderer("GRAPH") },
          nodes: { phase3_graph: { b: renderer("NODE") } },
        },
      });

      await loop.executeGraph(graph, { source: "command", args: "" });
      expect(seen).toMatchObject({ a: "GRAPH", b: "NODE" });
      await loop.executeGraph(extGraph, { source: "command", args: "" });
      expect(seen.ext).toBe("EXTENSION");

      seen.a = "";
      seen.b = "";
      await loop.executeGraph(
        graph,
        { source: "command", args: "" },
        { contextRenderer: renderer("CALL") },
      );
      expect(seen).toMatchObject({ a: "CALL", b: "CALL" });
    });

    it("调用级 renderer 沿 compose 传播，但仍按父子 scope 隔离", async () => {
      const pi = fakePi();
      let childContent = "";
      const childNode: Node = {
        kind: "code", id: "child_step", subGoal: "child",
        async execute() {
          const projected = pi.emit("context", { messages: [...pi._sentMessages] });
          const scope = projected.messages.find((message: any) =>
            message.customType === "loop_graph_node_scope" && message.details?.nodeId === "child_step");
          childContent = String(scope?.content);
          return { nodeId: "child_step", status: "ok", result: {} };
        },
      };
      const child = terminalGraph("phase3_child", childNode);
      const parentNode: Node = {
        kind: "graph", id: "compose_child", subGoal: "compose", graph: child, boundary: "compose",
      };
      const loop = createLoopGraphExtension(pi, {
        contextRenderer: renderer("EXT"),
        contextRenderers: { graphs: { phase3_child: renderer("CHILD_GRAPH") } },
      });

      await loop.executeGraph(
        terminalGraph("phase3_parent", parentNode),
        { source: "command", args: "" },
        { contextRenderer: renderer("CALL_SHARED") },
      );
      expect(childContent).toBe("CALL_SHARED");
    });

    it("renderer 抛错时图 fail-closed，不回退默认 CURRENT", async () => {
      const pi = fakePi();
      const node: Node = {
        kind: "code", id: "renderer_boom", subGoal: "secret",
        async execute() { return { nodeId: "renderer_boom", status: "ok", result: {} }; },
      };
      const loop = createLoopGraphExtension(pi, {
        contextRenderers: {
          nodes: {
            renderer_failure: {
              renderer_boom: () => { throw new Error("renderer failed"); },
            },
          },
        },
      });

      await expect(loop.executeGraph(terminalGraph("renderer_failure", node), { source: "command", args: "" }))
        .resolves.toMatchObject({ status: "failed", result: { reason: "renderer failed" } });
      expect(pi._sentMessages.some((message: any) =>
        message.customType === "loop_graph_node_scope" && message.details?.nodeId === "renderer_boom"))
        .toBe(false);
      expect(pi._sentMessages.some((message: any) => String(message.content).includes("=== CURRENT ===")))
        .toBe(false);
    });
  });

  describe("Phase 4 completion 与消息格式", () => {
    it("自定义 graph failure 文案", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, {
        modelMessageFormatter: {
          graphFailure: ({ graphId, reason }) => `GRAPH_FAIL:${graphId}:${reason}`,
        },
      });
      const node: Node = {
        kind: "code", id: "boom", subGoal: "boom",
        async execute() { throw new Error("broken"); },
      };
      await loop.executeGraph(terminalGraph("failure_format", node), { source: "command", args: "" });
      expect(pi.sendUserMessage).toHaveBeenCalledWith("GRAPH_FAIL:failure_format:broken");
    });

    it("自定义 completion tool result 文本但保留 details", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, {
        completionToolResultFormatter: ({ nodeId, status, result }) =>
          `DONE:${nodeId}:${status}:${String(result.answer)}`,
      });
      let toolPatch: any;
      const node: Node = {
        kind: "code", id: "complete_format", subGoal: "complete",
        async execute() {
          toolPatch = pi.emit("tool_result", {
            toolName: "__graph_complete__",
            details: { status: "ok", result: { answer: 42 } },
          });
          return { nodeId: "complete_format", status: "ok", result: {} };
        },
      };
      await loop.executeGraph(terminalGraph("completion_format", node), { source: "command", args: "" });
      expect(toolPatch).toEqual({ content: [{ type: "text", text: "DONE:complete_format:ok:42" }] });
    });
  });

  describe("Phase 5 skill provider 与 renderer", () => {
    it("等待异步 provider，并把只读上下文交给 skill renderer", async () => {
      const pi = fakePi();
      const events: string[] = [];
      const provider = vi.fn(async (_ref: string, context: any) => {
        events.push("provider-start");
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.node)).toBe(true);
        await Promise.resolve();
        events.push("provider-end");
        return "REMOTE_SKILL_BODY";
      });
      const skillRenderer = vi.fn((ref: string, content: string) => ({
        kind: "skill" as const,
        content: `REMOTE:${ref}:${content}`,
      }));
      const loop = createLoopGraphExtension(pi, { skillProvider: provider, skillRenderer });
      const node: Node = {
        kind: "code", id: "remote_skill_node", subGoal: "remote", skill: "remote-secret",
        async execute() {
          events.push("execute");
          return { nodeId: "remote_skill_node", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(terminalGraph("remote_skill", node), { source: "command", args: "" });

      expect(events).toEqual(["provider-start", "provider-end", "execute"]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(skillRenderer).toHaveBeenCalledWith(
        "remote-secret",
        "REMOTE_SKILL_BODY",
        expect.objectContaining({
          graph: expect.objectContaining({ id: "remote_skill" }),
          node: expect.objectContaining({ id: "remote_skill_node" }),
        }),
      );
    });

    it("自定义 skillRenderer 可隐藏内部 ref 并替换正文格式", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, {
        skillProvider: async () => "SECRET BODY",
        skillRenderer: () => ({ kind: "skill", content: "BUSINESS GUIDANCE" }),
      });
      let projected: any;
      const node: Node = {
        kind: "code", id: "hidden_skill", subGoal: "work", skill: "internal-skill-name",
        async execute() {
          projected = pi.emit("context", { messages: [...pi._sentMessages] });
          return { nodeId: "hidden_skill", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(terminalGraph("skill_hidden", node), { source: "command", args: "" });
      const text = projected.messages.map((message: any) => String(message.content)).join("\n");
      expect(text).toContain("BUSINESS GUIDANCE");
      expect(text).not.toContain("internal-skill-name");
      expect(text).not.toContain("SECRET BODY");
    });

    it("skillRenderer 返回 null 时隐藏 skill 名称与正文", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, {
        skillProvider: async () => "HIDDEN BODY",
        skillRenderer: () => null,
      });
      let projected: any;
      const node: Node = {
        kind: "code", id: "null_skill", subGoal: "work", skill: "hidden-ref",
        async execute() {
          projected = pi.emit("context", { messages: [...pi._sentMessages] });
          return { nodeId: "null_skill", status: "ok", result: {} };
        },
      };
      await loop.executeGraph(terminalGraph("skill_null", node), { source: "command", args: "" });
      const text = projected.messages.map((message: any) => String(message.content)).join("\n");
      expect(text).not.toContain("hidden-ref");
      expect(text).not.toContain("HIDDEN BODY");
    });

    it("missing/error 策略可选择 ignore 或 fail", async () => {
      const ignoredPi = fakePi();
      const ignored = createLoopGraphExtension(ignoredPi, {
        skillProvider: async () => null,
      });
      const ignoredNode: Node = {
        kind: "code", id: "ignored", subGoal: "ignored", skill: "missing",
        async execute() { return { nodeId: "ignored", status: "ok", result: {} }; },
      };
      await expect(ignored.executeGraph(terminalGraph("missing_ignore", ignoredNode), { source: "command", args: "" }))
        .resolves.toMatchObject({ status: "ok" });

      const failedPi = fakePi();
      const failed = createLoopGraphExtension(failedPi, {
        skillProvider: async () => null,
        skillFailure: { missing: "fail" },
      });
      await expect(failed.executeGraph(terminalGraph("missing_fail", ignoredNode), { source: "command", args: "" }))
        .resolves.toMatchObject({ status: "failed", result: { reason: "skill 未找到: missing" } });

      const errorPi = fakePi();
      const errored = createLoopGraphExtension(errorPi, {
        skillProvider: async () => { throw new Error("remote down"); },
        skillFailure: { error: "fail" },
      });
      await expect(errored.executeGraph(terminalGraph("error_fail", ignoredNode), { source: "command", args: "" }))
        .resolves.toMatchObject({ status: "failed", result: { reason: "remote down" } });
    });
  });

  describe("Phase 2 contextRenderer", () => {
    it("可完全隐藏默认 CURRENT 控制字段，并接收已加载 skill 与完成协议", async () => {
      const pi = fakePi();
      const skillBasePath = mkdtempSync(join(tmpdir(), "loop-graph-renderer-skill-"));
      const skillDir = join(skillBasePath, "private-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), "PRIVATE_SKILL_BODY", "utf8");
      const renderer = vi.fn((input: any) => ({
        anchor: {
          kind: "current" as const,
          content: `业务任务：${input.node.subGoal}\n完成工具：${input.completion.toolName}`,
        },
      }));
      const loop = createLoopGraphExtension(pi, { skillBasePath, contextRenderer: renderer });
      let projected: any;
      const node: Node = {
        kind: "code",
        id: "internal_validate_v2",
        subGoal: "检查业务答案",
        skill: "private-skill",
        tools: ["internal_tool"],
        async execute() {
          projected = pi.emit("context", { messages: [...pi._sentMessages] });
          return { nodeId: "internal_validate_v2", status: "ok", result: {} };
        },
      };
      pi.getAllTools.mockReturnValue([
        { name: "read" }, { name: "__graph_complete__" }, { name: "internal_tool" },
      ]);
      try {
        await loop.executeGraph(terminalGraph("renderer_hidden", node), { source: "command", args: "" });
      } finally {
        rmSync(skillBasePath, { recursive: true, force: true });
      }

      expect(renderer).toHaveBeenCalledTimes(1);
      expect(renderer.mock.calls[0][0]).toMatchObject({
        skill: { ref: "private-skill", content: "PRIVATE_SKILL_BODY" },
        completion: { toolName: "__graph_complete__", statuses: ["ok", "failed", "cancelled"] },
        reason: "node-enter",
      });
      const text = projected.messages.map((message: any) => String(message.content)).join("\n");
      expect(text).toContain("业务任务：检查业务答案");
      expect(text).not.toContain("internal_validate_v2");
      expect(text).not.toContain("internal_tool");
      expect(text).not.toContain("private-skill");
      expect(text).not.toContain("=== CURRENT ===");
    });

    it("scope 缺失和 compaction recovery 复用冻结结果，不重新调用 renderer", async () => {
      const pi = fakePi();
      const renderer = vi.fn(() => ({ anchor: { content: "FROZEN BUSINESS CONTEXT" } }));
      const loop = createLoopGraphExtension(pi, { contextRenderer: renderer });
      let scopeRecovery: any;
      let compactionRecovery: any;
      const node: Node = {
        kind: "code",
        id: "recover",
        subGoal: "recover",
        async execute() {
          scopeRecovery = pi.emit("context", {
            messages: [{ role: "user", content: "RAW OUTER SECRET" }],
          });
          pi.emit("session_compact", { reason: "manual", willRetry: false });
          compactionRecovery = pi.emit("context", {
            messages: [
              { role: "compactionSummary", summary: "SAFE SUMMARY" },
              { role: "assistant", content: "recent work" },
            ],
          });
          return { nodeId: "recover", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(terminalGraph("renderer_recovery", node), { source: "command", args: "" });

      expect(renderer).toHaveBeenCalledTimes(1);
      const scopeText = scopeRecovery.messages.map((message: any) => String(message.content)).join("\n");
      expect(scopeText).toContain("FROZEN BUSINESS CONTEXT");
      expect(scopeText).not.toContain("RAW OUTER SECRET");
      expect(compactionRecovery.messages[0].role).toBe("compactionSummary");
      expect(compactionRecovery.messages.some((message: any) => message.content === "FROZEN BUSINESS CONTEXT")).toBe(true);
      expect(compactionRecovery.messages.some((message: any) => message.content === "recent work")).toBe(true);
    });

    it("renderer 返回 null 时保留空 NodeScope 锚点并继续 fail-closed", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, { contextRenderer: () => null });
      let projected: any;
      const node: Node = {
        kind: "code",
        id: "silent",
        subGoal: "silent",
        async execute() {
          projected = pi.emit("context", { messages: [{ role: "user", content: "DO NOT LEAK" }] });
          return { nodeId: "silent", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(terminalGraph("renderer_null", node), { source: "command", args: "" });

      expect(projected.messages).toHaveLength(1);
      expect(projected.messages[0]).toMatchObject({
        customType: "loop_graph_node_scope",
        content: "",
        display: false,
      });
    });

    it("自定义 renderer 与现有 frameFormatter 可以共同工作", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, {
        contextRenderer: (input) => ({ anchor: { content: `NOW:${input.node.subGoal}` } }),
        frameFormatter: (frames) => `MEMORY:${frames.map((frame: any) => frame.summary).join(",")}`,
      });
      let projected: any;
      const first: Node = {
        kind: "code", id: "first", subGoal: "first", async execute() {
          return { nodeId: "first", status: "ok", result: {} };
        },
      };
      const second: Node = {
        kind: "code", id: "second", subGoal: "second", async execute() {
          projected = pi.emit("context", { messages: [...pi._sentMessages] });
          return { nodeId: "second", status: "ok", result: {} };
        },
      };
      const graph: Graph = {
        id: "renderer_frames", goal: "renderer frames",
        entries: [{ id: "entry", guard: () => true, startNodeId: "first" }],
        nodes: { first, second },
        routing: {
          first: { nodeId: "first", router: { kind: "first-match" }, edges: [edgeToNext("first", "second")] },
          second: { nodeId: "second", router: { kind: "first-match" }, edges: [edgeToEnd("second")] },
        },
      };

      await loop.executeGraph(graph, { source: "command", args: "" });
      const text = projected.messages.map((message: any) => String(message.content)).join("\n");
      expect(text).toContain("MEMORY:first done");
      expect(text).toContain("NOW:second");
    });

    it("嵌套 compose 返回父节点时，scope recovery 使用父 renderer 而不是子节点载荷", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, {
        contextRenderer: (input) => ({ anchor: { content: `CTX:${input.node.id}` } }),
      });
      const child = minimalGraph("renderer_nested_child");
      let parentRecovery: any;
      const graphNode: Node = {
        kind: "graph",
        id: "parent_graph_node",
        subGoal: "parent",
        graph: child,
        boundary: "compose",
        fold({ finalResult }) {
          parentRecovery = pi.emit("context", {
            messages: [{ role: "user", content: "RAW SHOULD DROP" }],
          });
          return { status: finalResult.status, result: finalResult.result };
        },
      };

      await loop.executeGraph(terminalGraph("renderer_nested_parent", graphNode), { source: "command", args: "" });

      const text = parentRecovery.messages.map((message: any) => String(message.content)).join("\n");
      expect(text).toContain("CTX:parent_graph_node");
      expect(text).not.toContain("CTX:start");
      expect(text).not.toContain("RAW SHOULD DROP");
    });

    it("renderer 输入与输出均无 Runtime 别名，外部变异不会改变运行状态或恢复正文", async () => {
      const pi = fakePi();
      const outputBlocks = [{ type: "text" as const, text: "ORIGINAL RENDERED" }];
      let projected: any;
      let runtimeFrameValue: unknown;
      const second: Node = {
        kind: "code", id: "second_snapshot", subGoal: "second original",
        async execute(instance) {
          outputBlocks[0].text = "MUTATED AFTER RENDER";
          runtimeFrameValue = (instance.frames[0] as any).result.nested.value;
          projected = pi.emit("context", { messages: [{ role: "user", content: "raw" }] });
          return { nodeId: "second_snapshot", status: "ok", result: {} };
        },
      };
      const first: Node = {
        kind: "code", id: "first_snapshot", subGoal: "first",
        async execute() {
          return { nodeId: "first_snapshot", status: "ok", result: { nested: { value: "runtime-original" } } };
        },
      };
      const graph: Graph = {
        id: "renderer_snapshot", goal: "snapshot",
        entries: [{ id: "entry", guard: () => true, startNodeId: "first_snapshot" }],
        nodes: { first_snapshot: first, second_snapshot: second },
        routing: {
          first_snapshot: {
            nodeId: "first_snapshot", router: { kind: "first-match" }, edges: [{
              id: "next", from: "first_snapshot", to: "second_snapshot", priority: 1, guard: () => true,
              migrate(_instance, completion) {
                return { frame: { summary: "snapshot", result: completion.result } };
              },
            }],
          },
          second_snapshot: { nodeId: "second_snapshot", router: { kind: "first-match" }, edges: [edgeToEnd("second_snapshot")] },
        },
      };
      const renderer = vi.fn((input: any) => {
        if (input.node.id === "second_snapshot") {
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(input.node)).toBe(true);
          expect(Object.isFrozen(input.frames)).toBe(true);
          expect(Object.isFrozen(input.frames[0])).toBe(true);
          expect(Object.isFrozen(input.frames[0].result.nested)).toBe(true);
          expect(() => { input.node.subGoal = "renderer-mutated"; }).toThrow();
          expect(() => { input.frames[0].result.nested.value = "renderer-mutated"; }).toThrow();
          return { anchor: { content: outputBlocks } };
        }
        return { anchor: { content: "FIRST" } };
      });
      const loop = createLoopGraphExtension(pi, { contextRenderer: renderer });

      await loop.executeGraph(graph, { source: "command", args: "" });

      expect(second.subGoal).toBe("second original");
      expect(runtimeFrameValue).toBe("runtime-original");
      const scopeMessage = projected.messages.find((message: any) => message.customType === "loop_graph_node_scope");
      expect(scopeMessage.content).toEqual([{ type: "text", text: "ORIGINAL RENDERED" }]);
      expect(Object.isFrozen(scopeMessage.content)).toBe(true);
      expect(Object.isFrozen(scopeMessage.content[0])).toBe(true);
    });
  });

  describe("运行限制配置", () => {
    it.each([
      { rootMaxSteps: 0 },
      { childMaxSteps: -1 },
      { agentRunTimeoutMs: Number.NaN },
      { rootMaxSteps: 1.5 },
    ])("拒绝非法 limits: %o", (limits) => {
      expect(() => createLoopGraphExtension(fakePi(), { limits }))
        .toThrow(/必须是有限正整数/);
    });

    it("rootMaxSteps 控制顶层图循环上限", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, { limits: { rootMaxSteps: 2 } });
      const graph = minimalGraph("root_limit");
      graph.routing.start.edges = [{
        id: "again",
        from: "start",
        to: "start",
        priority: 1,
        guard: () => true,
        migrate(_instance, completion) {
          return {
            frame: { nodeId: completion.nodeId, status: completion.status, summary: "again", result: {} },
          };
        },
      }];

      await expect(loop.executeGraph(graph, { source: "command", args: "" }))
        .resolves.toMatchObject({
          status: "failed",
          steps: 2,
          result: { reason: "Max steps (2) exceeded" },
        });
    });

    it("childMaxSteps 控制 call 子图循环上限", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi, { limits: { childMaxSteps: 1 } });
      const child = minimalGraph("child_limit");
      child.routing.start.edges = [{
        id: "again",
        from: "start",
        to: "start",
        priority: 1,
        guard: () => true,
        migrate(_instance, completion) {
          return {
            frame: { nodeId: completion.nodeId, status: completion.status, summary: "again", result: {} },
          };
        },
      }];
      const parentNode: Node = {
        kind: "graph",
        id: "child",
        subGoal: "run child",
        graph: child,
        boundary: "call",
      };
      const parent = terminalGraph("parent_limit", parentNode);

      await expect(loop.executeGraph(parent, { source: "command", args: "" }))
        .resolves.toMatchObject({
          status: "failed",
          result: { reason: "Max steps (1) exceeded" },
        });
    });
  });

  describe("同实例并发保护", () => {
    it("第二个 root executeGraph 在覆盖 active runtime 前 fail-fast，结束后可再次运行", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      const blocker = new Promise<void>((resolve) => { release = resolve; });
      const blockingNode: Node = {
        kind: "code",
        id: "blocking",
        subGoal: "block",
        async execute() {
          entered();
          await blocker;
          return { nodeId: "blocking", status: "ok", result: {} };
        },
      };
      const graph = terminalGraph("concurrent_root", blockingNode);

      const first = loop.executeGraph(graph, { source: "command", args: "first" });
      await enteredPromise;

      await expect(loop.executeGraph(graph, { source: "command", args: "second" }))
        .rejects.toThrow(/独立 AgentSession 或 delegate host/);

      release();
      await expect(first).resolves.toMatchObject({ status: "ok" });
      await expect(loop.executeGraph(minimalGraph("after_release"), { source: "command", args: "" }))
        .resolves.toMatchObject({ status: "ok" });
    });

    it("启动日志抛错时也会释放 root busy 状态", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const graphStart = vi.spyOn(debugLog, "graphStart")
        .mockImplementationOnce(() => { throw new Error("log unavailable"); });
      try {
        await expect(loop.executeGraph(minimalGraph("log_failure"), { source: "command", args: "" }))
          .resolves.toMatchObject({ status: "failed", result: { reason: "log unavailable" } });
        await expect(loop.executeGraph(minimalGraph("after_log_failure"), { source: "command", args: "" }))
          .resolves.toMatchObject({ status: "ok" });
      } finally {
        graphStart.mockRestore();
      }
    });
  });

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
    it("ctx.state 在同一 AgentInstance 中跨 visit 保留，createState 只执行一次", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const seen: number[] = [];
      let createCount = 0;
      let visits = 0;
      let scratchKeys: string[] = [];
      const stateful: Mechanism<{ count: number }> = {
        name: "stateful",
        createState() {
          createCount += 1;
          return { count: 0 };
        },
        onNodeEnter(ctx) {
          ctx.state.count += 1;
          seen.push(ctx.state.count);
        },
      };
      const g = minimalGraph("mech_state_visits");
      g.mechanisms = [stateful];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "访问两次",
        async execute(instance) {
          scratchKeys = Object.keys(instance.scratch);
          visits += 1;
          return { nodeId: "start", status: "ok", result: { visits } };
        },
      };
      g.routing.start = {
        nodeId: "start",
        router: { kind: "first-match" },
        edges: [
          {
            id: "again",
            from: "start",
            to: "start",
            priority: 2,
            guard: (completion) => completion.result.visits === 1,
            migrate(_instance, completion) {
              return { frame: { result: completion.result }, input: {} };
            },
          },
          { ...edgeToEnd("start"), guard: (completion) => completion.result.visits === 2 },
        ],
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(createCount).toBe(1);
      expect(seen).toEqual([1, 2]);
      expect(scratchKeys).toEqual([]);
    });

    it("同名但不同对象的 mechanism state 完全隔离", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const seen: string[] = [];
      const makeMechanism = (label: string): Mechanism<{ count: number }> => ({
        name: "same-name",
        createState: () => ({ count: 0 }),
        onNodeEnter(ctx) {
          ctx.state.count += 1;
          seen.push(`${label}:${ctx.state.count}`);
        },
      });
      const g = minimalGraph("mech_state_object_identity");
      g.mechanisms = [makeMechanism("a"), makeMechanism("b")];

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(seen).toEqual(["a:1", "b:1"]);
    });

    it("call 创建新 state，compose 在共享 instance 上复用 state", async () => {
      for (const boundary of ["call", "compose"] as const) {
        const pi = fakePi();
        const loop = createLoopGraphExtension(pi);
        const seen: number[] = [];
        let createCount = 0;
        const mechanism: Mechanism<{ visits: number }> = {
          name: `${boundary}-state`,
          createState() {
            createCount += 1;
            return { visits: 0 };
          },
          onNodeEnter(ctx) {
            ctx.state.visits += 1;
            seen.push(ctx.state.visits);
          },
        };
        const child = minimalGraph(`mech_state_${boundary}_child`);
        child.mechanisms = [mechanism];
        const makeGraphNode = (id: string): Node => ({
          kind: "graph",
          id,
          subGoal: `${boundary} child`,
          graph: child,
          boundary,
          ...(boundary === "compose"
            ? { fold: ({ finalResult }: any) => ({ status: finalResult.status, result: finalResult.result }) }
            : {}),
        });
        const parent: Graph = {
          id: `mech_state_${boundary}_parent`,
          goal: "连续调用两次",
          entries: [{ id: "entry", guard: () => true, startNodeId: "first" }],
          nodes: { first: makeGraphNode("first"), second: makeGraphNode("second") },
          routing: {
            first: {
              nodeId: "first",
              router: { kind: "first-match" },
              edges: [edgeToNext("first", "second")],
            },
            second: {
              nodeId: "second",
              router: { kind: "first-match" },
              edges: [edgeToEnd("second")],
            },
          },
        };

        const result = await loop.executeGraph(parent, { source: "command", args: "" });

        expect(result.status).toBe("ok");
        expect(seen).toEqual(boundary === "call" ? [1, 1] : [1, 2]);
        expect(createCount).toBe(boundary === "call" ? 2 : 1);
      }
    });

    it("createState 失败遵循 failurePolicy，且不执行依赖无效 state 的 Hook", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let entered = false;
      let executed = false;
      let routed: any;
      const g = minimalGraph("mech_state_init_failure");
      g.mechanisms = [{
        name: "broken-state",
        failurePolicy: "fail-node",
        createState() { throw new Error("state init failed"); },
        onNodeEnter() { entered = true; },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "不应执行",
        async execute() {
          executed = true;
          return { nodeId: "start", status: "ok", result: {} };
        },
      };
      g.routing.start!.edges[0].guard = (completion) => {
        routed = completion;
        return completion.status === "failed";
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(entered).toBe(false);
      expect(executed).toBe(false);
      expect(routed).toMatchObject({
        nodeId: "start",
        status: "failed",
        result: {
          mechanismFailure: {
            mechanismName: "broken-state",
            phase: "createState",
            policy: "fail-node",
          },
        },
      });
      expect(result.status).toBe("failed");
    });

    it("scoped events 在 20 次循环中只命中当前 visit，底层监听器数量恒定", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const observedVisits: number[] = [];
      const subscriptions: any[] = [];
      let visits = 0;

      const g = minimalGraph("mech_scoped_event_loop");
      g.mechanisms = [{
        name: "turn-observer",
        onNodeEnter(ctx) {
          subscriptions.push(ctx.events.onTurnStart(() => {
            observedVisits.push(ctx.scope.visit);
          }));
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "循环 20 次",
        async execute() {
          visits += 1;
          await pi.emitAsync("turn_start", {
            type: "turn_start",
            turnIndex: visits - 1,
            timestamp: Date.now(),
          });
          return { nodeId: "start", status: "ok", result: { visits } };
        },
      };
      g.routing.start = {
        nodeId: "start",
        router: { kind: "first-match" },
        edges: [
          {
            id: "again",
            from: "start",
            to: "start",
            priority: 2,
            guard: (completion) => Number(completion.result.visits) < 20,
            migrate(_instance, completion) {
              return { frame: { result: completion.result }, input: {} };
            },
          },
          {
            ...edgeToEnd("start"),
            guard: (completion) => completion.result.visits === 20,
          },
        ],
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });
      await pi.emitAsync("turn_start", {
        type: "turn_start",
        turnIndex: 99,
        timestamp: Date.now(),
      });

      expect(result.status).toBe("ok");
      expect(observedVisits).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(subscriptions.every((subscription) => subscription.disposed)).toBe(true);
      expect(pi._handlerCount("turn_start")).toBe(1);
      expect(pi._handlerCount("turn_end")).toBe(1);
      // 一个是 __graph_complete__ 捕获器，一个是 MechanismEventBroker。
      expect(pi._handlerCount("tool_result")).toBe(2);
    });

    it("scoped event 支持手动幂等 dispose", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let observed = 0;
      let subscription: any;
      const g = minimalGraph("mech_event_manual_dispose");
      g.mechanisms = [{
        name: "manual-dispose",
        onNodeEnter(ctx) {
          subscription = ctx.events.onTurnStart(() => { observed += 1; });
          subscription.dispose();
          subscription.dispose();
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "不应收到事件",
        async execute() {
          await pi.emitAsync("turn_start", {
            type: "turn_start",
            turnIndex: 0,
            timestamp: Date.now(),
          });
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(subscription.disposed).toBe(true);
      expect(observed).toBe(0);
    });

    it("turn_start、turn_end 与 tool_result 三类 scoped event 均可观察", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const observed: string[] = [];
      const g = minimalGraph("mech_all_scoped_events");
      g.mechanisms = [{
        name: "all-events",
        onNodeEnter(ctx) {
          ctx.events.onTurnStart((event) => { observed.push(`start:${event.turnIndex}`); });
          ctx.events.onTurnEnd((event) => { observed.push(`end:${event.turnIndex}`); });
          ctx.events.onToolResult((event) => { observed.push(`tool:${event.toolName}`); });
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "观察全部事件",
        async execute() {
          await pi.emitAsync("turn_start", {
            type: "turn_start",
            turnIndex: 3,
            timestamp: Date.now(),
          });
          await pi.emitAsync("tool_result", {
            type: "tool_result",
            toolCallId: "call-all",
            toolName: "read",
            input: { path: "x" },
            content: [{ type: "text", text: "x" }],
            details: undefined,
            isError: false,
          });
          await pi.emitAsync("turn_end", {
            type: "turn_end",
            turnIndex: 3,
            message: { role: "assistant", content: [], timestamp: Date.now() },
            toolResults: [],
          });
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(observed).toEqual(["start:3", "tool:read", "end:3"]);
    });

    it("事件快照无别名且 handler 串行；continue 错误不阻止后续机制", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];
      let seenEvent: any;
      const originalInput = { nested: { value: 1 } };
      const g = minimalGraph("mech_event_snapshot_order");
      g.mechanisms = [
        {
          name: "first",
          onNodeEnter(ctx) {
            ctx.events.onToolResult(async (event) => {
              order.push("first:start");
              seenEvent = event;
              expect(Object.isFrozen(event)).toBe(true);
              expect(Object.isFrozen((event.input as any).nested)).toBe(true);
              await Promise.resolve();
              order.push("first:end");
              throw new Error("optional audit failed");
            });
          },
        },
        {
          name: "second",
          onNodeEnter(ctx) {
            ctx.events.onToolResult(() => { order.push("second"); });
          },
        },
      ];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "发出工具结果",
        async execute() {
          await pi.emitAsync("tool_result", {
            type: "tool_result",
            toolCallId: "call-1",
            toolName: "custom",
            input: originalInput,
            content: [{ type: "text", text: "ok" }],
            details: { trace: 1 },
            isError: false,
          });
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });
      originalInput.nested.value = 9;

      expect(result.status).toBe("ok");
      expect(order).toEqual(["first:start", "first:end", "second"]);
      expect(seenEvent.input).toEqual({ nested: { value: 1 } });
    });

    it("event handler 的 fail-node 在安全检查点替换 completion 并继续 Router", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let routed: any;
      let exitStatus: string | undefined;
      const g = minimalGraph("mech_event_fail_node");
      g.mechanisms = [{
        name: "required-turn-check",
        failurePolicy: "fail-node",
        onNodeEnter(ctx) {
          ctx.events.onTurnStart(() => { throw new Error("turn check failed"); });
        },
        onNodeExit(ctx) { exitStatus = ctx.completion.status; },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "事件失败",
        async execute() {
          await pi.emitAsync("turn_start", {
            type: "turn_start",
            turnIndex: 0,
            timestamp: Date.now(),
          });
          return { nodeId: "start", status: "ok", result: { aiClaimed: true } };
        },
      };
      g.routing.start!.edges[0].guard = (completion) => {
        routed = completion;
        return completion.status === "failed";
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(exitStatus).toBe("failed");
      expect(routed).toMatchObject({
        nodeId: "start",
        status: "failed",
        result: {
          reason: expect.stringContaining("turn check failed"),
          mechanismFailure: {
            mechanismName: "required-turn-check",
            phase: "turn_start",
            policy: "fail-node",
          },
        },
      });
      expect(result.status).toBe("failed");
    });

    it("event handler 的 fail-graph 触发 onNodeError 和 cleanup", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];
      const g = minimalGraph("mech_event_fail_graph");
      g.mechanisms = [{
        name: "required-tool-audit",
        failurePolicy: "fail-graph",
        onNodeEnter(ctx) {
          ctx.scope.onCleanup(() => { order.push("cleanup"); });
          ctx.events.onToolResult(() => { throw new Error("audit unavailable"); });
        },
        onNodeError(ctx) { order.push(`error:${ctx.error.message}`); },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "事件失败整图",
        async execute() {
          await pi.emitAsync("tool_result", {
            type: "tool_result",
            toolCallId: "call-2",
            toolName: "custom",
            input: {},
            content: [{ type: "text", text: "ok" }],
            details: null,
            isError: false,
          });
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(result.status).toBe("failed");
      expect(result.result.reason).toContain("audit unavailable");
      expect(order[0]).toContain("error:");
      expect(order[1]).toBe("cleanup");
    });

    it("call/compose 嵌套期间只分发给当前 scope，返回父节点后恢复父订阅", async () => {
      for (const boundary of ["call", "compose"] as const) {
        const pi = fakePi();
        const loop = createLoopGraphExtension(pi);
        const observed: string[] = [];
        const child = minimalGraph(`event_scope_${boundary}_child`);
        child.nodes.start = {
          kind: "code",
          id: "start",
          subGoal: "子节点发事件",
          async execute() {
            await pi.emitAsync("turn_start", {
              type: "turn_start",
              turnIndex: 1,
              timestamp: Date.now(),
            });
            return { nodeId: "start", status: "ok", result: {} };
          },
        };
        child.mechanisms = [{
          name: "child-local",
          onNodeEnter(ctx) {
            ctx.events.onTurnStart(() => { observed.push(`child-local:${ctx.node.id}`); });
          },
        }];

        const graphNode: Node = {
          kind: "graph",
          id: "invoke",
          subGoal: "调用子图",
          graph: child,
          boundary,
          ...(boundary === "compose"
            ? { fold: ({ finalResult }: any) => ({ status: finalResult.status, result: finalResult.result }) }
            : {}),
        };
        const parent = terminalGraph(`event_scope_${boundary}_parent`, graphNode);
        parent.mechanisms = [{
          name: "parent-global",
          onNodeEnter(ctx) {
            ctx.events.onTurnStart(() => { observed.push(`parent-global:${ctx.node.id}`); });
          },
          async onNodeExit(ctx) {
            if (ctx.node.id !== "invoke") return;
            await pi.emitAsync("turn_start", {
              type: "turn_start",
              turnIndex: 2,
              timestamp: Date.now(),
            });
          },
        }];

        const result = await loop.executeGraph(parent, { source: "command", args: "" });

        expect(result.status).toBe("ok");
        expect(observed).toEqual(boundary === "call"
          ? ["child-local:start", "parent-global:invoke"]
          : ["parent-global:start", "child-local:start", "parent-global:invoke"]);
      }
    });

    it("onNodeExit 在路由前收到无别名只读 completion，随后执行 cleanup", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];
      const liveResult = { nested: { value: 1 } };
      let exitResult: any;

      const g = minimalGraph("mech_exit_snapshot");
      g.mechanisms = [{
        name: "exit-observer",
        onNodeEnter(ctx) {
          order.push("enter");
          ctx.scope.onCleanup(() => { order.push("cleanup"); });
        },
        onNodeExit(ctx) {
          order.push("exit");
          exitResult = ctx.completion.result;
          expect(Object.isFrozen(ctx.completion)).toBe(true);
          expect(Object.isFrozen((ctx.completion.result as any).nested)).toBe(true);
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "完成",
        async execute() {
          order.push("execute");
          return { nodeId: "start", status: "ok", result: liveResult };
        },
      };
      g.routing.start!.edges[0].migrate = (_instance, completion) => {
        order.push("migrate");
        return { frame: { result: completion.result } };
      };

      await loop.executeGraph(g, { source: "command", args: "" });
      liveResult.nested.value = 9;

      expect(order).toEqual(["enter", "execute", "exit", "migrate", "cleanup"]);
      expect(exitResult).toEqual({ nested: { value: 1 } });
    });

    it("默认 continue：exit hook 抛错只记日志，后续 hook 与节点路由继续", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];
      const g = minimalGraph("mech_exit_continue");
      g.mechanisms = [
        {
          name: "broken-observer",
          onNodeExit() {
            order.push("broken");
            throw new Error("observer failed");
          },
        },
        {
          name: "healthy-observer",
          onNodeExit() { order.push("healthy"); },
        },
      ];

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(result.status).toBe("ok");
      expect(order).toEqual(["broken", "healthy"]);
    });

    it("fail-node 的 enter hook 跳过 execute，并生成可信 failed completion 交给 Router", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let executed = false;
      let routedCompletion: any;
      let exitStatus: string | undefined;
      let cleanupCount = 0;
      const g = minimalGraph("mech_enter_fail_node");
      g.mechanisms = [{
        name: "required-policy",
        failurePolicy: "fail-node",
        onNodeEnter(ctx) {
          ctx.scope.onCleanup(() => { cleanupCount += 1; });
          throw new Error("permission denied");
        },
        onNodeExit(ctx) {
          exitStatus = ctx.completion.status;
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "不应执行",
        async execute() {
          executed = true;
          return { nodeId: "forged", status: "ok", result: {} };
        },
      };
      g.routing.start!.edges[0].guard = (completion) => {
        routedCompletion = completion;
        return completion.status === "failed";
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(executed).toBe(false);
      expect(exitStatus).toBe("failed");
      expect(routedCompletion).toMatchObject({
        nodeId: "start",
        status: "failed",
        result: {
          reason: expect.stringContaining("permission denied"),
          mechanismFailure: {
            mechanismName: "required-policy",
            phase: "onNodeEnter",
            policy: "fail-node",
          },
        },
      });
      expect(result.status).toBe("failed");
      expect(cleanupCount).toBe(1);
    });

    it("fail-graph 优先于 fail-node，全部同阶段 hook 执行后触发 onNodeError 与 cleanup", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];
      const g = minimalGraph("mech_fail_graph_priority");
      g.mechanisms = [
        {
          name: "node-failure",
          failurePolicy: "fail-node",
          onNodeEnter(ctx) {
            order.push("enter-node-failure");
            ctx.scope.onCleanup(() => { order.push("cleanup-node"); });
            throw new Error("node policy failed");
          },
          onNodeError(ctx) {
            order.push(`error-node:${ctx.error.message.includes("graph policy failed")}`);
          },
        },
        {
          name: "graph-failure",
          failurePolicy: "fail-graph",
          onNodeEnter(ctx) {
            order.push("enter-graph-failure");
            ctx.scope.onCleanup(() => { order.push("cleanup-graph"); });
            throw new Error("graph policy failed");
          },
          onNodeError() { order.push("error-graph"); },
        },
      ];

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(result.status).toBe("failed");
      expect(result.result.reason).toContain("graph policy failed");
      expect(order).toEqual([
        "enter-node-failure",
        "enter-graph-failure",
        "error-node:true",
        "error-graph",
        "cleanup-graph",
        "cleanup-node",
      ]);
    });

    it("onNodeError hook 抛错不会替换 execute 的原始错误", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let errorView: any;
      let cleanupCount = 0;
      const g = minimalGraph("mech_error_observer_failure");
      g.mechanisms = [{
        name: "broken-error-observer",
        failurePolicy: "fail-graph",
        onNodeEnter(ctx) {
          ctx.scope.onCleanup(() => { cleanupCount += 1; });
        },
        onNodeError(ctx) {
          errorView = ctx.error;
          throw new Error("secondary error");
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "抛出主错误",
        async execute() { throw new Error("primary execute error"); },
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(result.status).toBe("failed");
      expect(result.result.reason).toContain("primary execute error");
      expect(result.result.reason).not.toContain("secondary error");
      expect(errorView).toMatchObject({ name: "Error", message: "primary execute error" });
      expect(Object.isFrozen(errorView)).toBe(true);
      expect(cleanupCount).toBe(1);
    });

    it("migrate 阶段抛错也会触发 onNodeError，然后关闭 scope", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const order: string[] = [];
      const g = minimalGraph("mech_migrate_error_hook");
      g.mechanisms = [{
        name: "migrate-observer",
        onNodeEnter(ctx) {
          ctx.scope.onCleanup(() => { order.push("cleanup"); });
        },
        onNodeExit() { order.push("exit"); },
        onNodeError(ctx) { order.push(`error:${ctx.error.message}`); },
      }];
      g.routing.start!.edges[0].migrate = () => {
        order.push("migrate");
        throw new Error("migration exploded");
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(result.status).toBe("failed");
      expect(result.result.reason).toContain("migration exploded");
      expect(order).toEqual([
        "exit",
        "migrate",
        "error:migration exploded",
        "cleanup",
      ]);
    });

    it("scope 在节点内活跃，退出时 abort 并按 LIFO 执行 cleanup", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const cleanupOrder: string[] = [];
      let scope: any;

      const g = minimalGraph("mech_scope_lifecycle");
      g.mechanisms = [{
        name: "lifecycle",
        onNodeEnter(ctx) {
          scope = ctx.scope;
          expect(ctx.scope.isActive()).toBe(true);
          expect(ctx.scope.signal.aborted).toBe(false);
          ctx.scope.onCleanup(() => { cleanupOrder.push("first"); });
          ctx.scope.onCleanup(async () => { cleanupOrder.push("second"); });
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "检查 scope",
        async execute() {
          expect(scope.isActive()).toBe(true);
          expect(scope.signal.aborted).toBe(false);
          return { nodeId: "start", status: "ok", result: {} };
        },
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      expect(scope.isActive()).toBe(false);
      expect(scope.signal.aborted).toBe(true);
      expect(cleanupOrder).toEqual(["second", "first"]);
    });

    it("旧 visit 的安全 appendContext 在后继 visit 返回 false 且不写消息", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const appends: Array<(content: string) => boolean> = [];
      const cleanupVisits: number[] = [];
      let runCount = 0;

      const g = minimalGraph("mech_stale_append");
      g.mechanisms = [{
        name: "capture",
        onNodeEnter(ctx) {
          appends.push(ctx.appendContext);
          ctx.scope.onCleanup(() => { cleanupVisits.push(ctx.scope.visit); });
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "循环两次",
        async execute() {
          runCount += 1;
          if (runCount === 2) {
            expect(appends[0]("旧 scope 不应写入")).toBe(false);
            expect(appends[1]("当前 scope 可以写入")).toBe(true);
          }
          return { nodeId: "start", status: "ok", result: { runCount } };
        },
      };
      g.routing.start = {
        nodeId: "start",
        router: { kind: "first-match" },
        edges: [
          {
            id: "again",
            from: "start",
            to: "start",
            priority: 2,
            guard: (completion) => completion.result.runCount === 1,
            migrate(_instance, completion) {
              return { frame: { result: completion.result }, input: {} };
            },
          },
          {
            ...edgeToEnd("start"),
            guard: (completion) => completion.result.runCount === 2,
          },
        ],
      };

      await loop.executeGraph(g, { source: "command", args: "" });

      const mechanismContents = pi._sentMessages
        .filter((message: any) => message.customType === "loop_graph_mechanism")
        .map((message: any) => message.content);
      expect(mechanismContents).toContain("当前 scope 可以写入");
      expect(mechanismContents).not.toContain("旧 scope 不应写入");
      expect(cleanupVisits).toEqual([1, 2]);
      expect(appends[1]("图结束后也不能写入")).toBe(false);
    });

    it("execute 抛错时仍执行 cleanup，cleanup 错误不覆盖主错误或阻止剩余清理", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      const cleanupOrder: string[] = [];

      const g = minimalGraph("mech_error_cleanup");
      g.mechanisms = [{
        name: "cleanup-on-error",
        onNodeEnter(ctx) {
          ctx.scope.onCleanup(() => { cleanupOrder.push("survived"); });
          ctx.scope.onCleanup(() => {
            cleanupOrder.push("throws");
            throw new Error("cleanup failed");
          });
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "抛错",
        async execute() {
          throw new Error("execute failed");
        },
      };

      const result = await loop.executeGraph(g, { source: "command", args: "" });

      expect(result.status).toBe("failed");
      expect(result.result.reason).toContain("execute failed");
      expect(cleanupOrder).toEqual(["throws", "survived"]);
    });

    it("裸 ctx.pi.on 保持非托管语义，循环访问会累积原生监听器", async () => {
      const pi = fakePi();
      const loop = createLoopGraphExtension(pi);
      let visits = 0;
      let observed = 0;

      const g = minimalGraph("mech_unsafe_pi_listener");
      g.mechanisms = [{
        name: "unsafe-listener",
        onNodeEnter(ctx) {
          ctx.pi.on("turn_start", () => { observed += 1; });
        },
      }];
      g.nodes.start = {
        kind: "code",
        id: "start",
        subGoal: "循环两次",
        async execute() {
          visits += 1;
          return { nodeId: "start", status: "ok", result: { visits } };
        },
      };
      g.routing.start = {
        nodeId: "start",
        router: { kind: "first-match" },
        edges: [
          {
            id: "again",
            from: "start",
            to: "start",
            priority: 2,
            guard: (completion) => completion.result.visits === 1,
            migrate(_instance, completion) {
              return { frame: { result: completion.result }, input: {} };
            },
          },
          { ...edgeToEnd("start"), guard: (completion) => completion.result.visits === 2 },
        ],
      };

      await loop.executeGraph(g, { source: "command", args: "" });
      pi.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });

      expect(observed).toBe(2);
    });

    it("call 与 compose 子图节点都在各自 visit 结束时 cleanup", async () => {
      for (const boundary of ["call", "compose"] as const) {
        const pi = fakePi();
        const loop = createLoopGraphExtension(pi);
        const cleaned: string[] = [];
        const scopes: any[] = [];

        const child = minimalGraph(`mech_${boundary}_child`);
        child.mechanisms = [{
          name: `${boundary}-child-mechanism`,
          onNodeEnter(ctx) {
            scopes.push(ctx.scope);
            ctx.scope.onCleanup(() => { cleaned.push(`${boundary}:${ctx.scope.visit}`); });
          },
        }];
        const graphNode: Node = {
          kind: "graph",
          id: "invoke",
          subGoal: `通过 ${boundary} 调用子图`,
          graph: child,
          boundary,
          ...(boundary === "compose"
            ? { fold: ({ finalResult }: any) => ({ status: finalResult.status, result: finalResult.result }) }
            : {}),
        };
        const parent = terminalGraph(`mech_${boundary}_parent`, graphNode);

        const result = await loop.executeGraph(parent, { source: "command", args: "" });

        expect(result.status).toBe("ok");
        expect(cleaned).toEqual([`${boundary}:1`]);
        expect(scopes).toHaveLength(1);
        expect(scopes[0].isActive()).toBe(false);
        expect(scopes[0].signal.aborted).toBe(true);
      }
    });

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

describe("Mechanism Phase 5-6 lifecycle 与安全能力", () => {
  it("每次 runAgent 使用独立 agentRunId，并按顺序分派 turn/tool Hook", async () => {
    const pi = fakePi();
    const order: string[] = [];
    let runNumber = 0;
    pi.sendMessage.mockImplementation((_message: any, options?: { triggerTurn?: boolean }) => {
      if (!options?.triggerTurn) return;
      const sequence = ++runNumber;
      queueMicrotask(async () => {
        await pi.emitAsync("turn_start", { type: "turn_start", turnIndex: 0, timestamp: sequence });
        await pi.emitAsync("tool_execution_start", {
          type: "tool_execution_start",
          toolCallId: `read-${sequence}`,
          toolName: "read",
          args: { path: `file-${sequence}` },
        });
        await pi.emitAsync("tool_result", {
          type: "tool_result",
          toolCallId: `read-${sequence}`,
          toolName: "read",
          input: { path: `file-${sequence}` },
          content: [{ type: "text", text: "ok" }],
          details: undefined,
          isError: false,
        });
        await pi.emitAsync("turn_end", {
          type: "turn_end",
          turnIndex: 0,
          message: { role: "assistant", content: [], timestamp: sequence },
          toolResults: [],
        });
        await pi.emitAsync("tool_result", {
          type: "tool_result",
          toolCallId: `complete-${sequence}`,
          toolName: "__graph_complete__",
          input: {},
          content: [{ type: "text", text: "done" }],
          details: { status: "ok", result: { sequence } },
          isError: false,
        });
        await pi.emitAsync("agent_end", { type: "agent_end", messages: [] });
      });
    });
    const loop = createLoopGraphExtension(pi);
    const graph = minimalGraph("phase5_run_ids");
    graph.mechanisms = [{
      name: "lifecycle",
      beforeAgentRun(ctx) { order.push(`before:${ctx.agentRunId}`); },
      onTurnStart(ctx) { order.push(`turn-start:${ctx.agentRunId}`); },
      onToolStart(ctx) { order.push(`tool-start:${ctx.agentRunId}`); },
      onToolResult(ctx) {
        if (ctx.event.toolName === "read") order.push(`tool-result:${ctx.agentRunId}`);
      },
      onTurnEnd(ctx) { order.push(`turn-end:${ctx.agentRunId}`); },
    }];
    graph.nodes.start = {
      kind: "code",
      id: "start",
      subGoal: "run twice",
      async execute(_instance, _input, ctx) {
        await ctx.runAgent({ prompt: "first" });
        // 第一轮已结束、第二轮尚未开始：晚到事件不能被正式 Hook 接收或误归属。
        await pi.emitAsync("turn_start", { type: "turn_start", turnIndex: 99, timestamp: 99 });
        return ctx.runAgent({ prompt: "second" });
      },
    };

    const result = await loop.executeGraph(graph, { source: "command", args: "" });
    expect(result.status).toBe("ok");
    expect(order).toEqual([
      "before:1", "turn-start:1", "tool-start:1", "tool-result:1", "turn-end:1",
      "before:2", "turn-start:2", "tool-start:2", "tool-result:2", "turn-end:2",
    ]);
  });

  it("串行组合工具 patch、结果脱敏与决策 trace，并重新校验 schema", async () => {
    const pi = fakePi();
    let executedInput: Record<string, unknown> | null = null;
    let modelContent: unknown;
    let observerContent: unknown;
    let trace: readonly any[] = [];
    pi.sendMessage.mockImplementation((_message: any, options?: { triggerTurn?: boolean }) => {
      if (!options?.triggerTurn) return;
      queueMicrotask(async () => {
        const call = {
          type: "tool_call",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: "unsafe" },
        };
        const decisions = await pi.emitAsync("tool_call", call);
        const blocked = decisions.some((item: any) => item?.block);
        if (!blocked) {
          executedInput = { ...call.input };
          const results = await pi.emitAsync("tool_result", {
            type: "tool_result",
            toolCallId: "read-1",
            toolName: "read",
            input: call.input,
            content: [{ type: "text", text: "secret" }],
            details: { privateRuntimeValue: true },
            isError: false,
          });
          modelContent = results.find((item: any) => item?.content)?.content;
        }
        await pi.emitAsync("tool_result", {
          type: "tool_result",
          toolCallId: "complete-1",
          toolName: "__graph_complete__",
          input: {},
          content: [{ type: "text", text: "done" }],
          details: { status: "ok", result: {} },
          isError: false,
        });
        await pi.emitAsync("agent_end", { type: "agent_end", messages: [] });
      });
    });
    const loop = createLoopGraphExtension(pi);
    const graph = minimalGraph("phase6_tool_pipeline");
    graph.mechanisms = [
      {
        name: "path-policy",
        beforeToolCall(ctx) {
          if (ctx.event.toolName === "read") return { action: "patch", input: { path: "safe.txt" } };
        },
        afterToolResult(ctx) {
          if (ctx.event.toolName === "read") {
            return { action: "replace", content: [{ type: "text", text: "[redacted]" }] };
          }
        },
      },
      {
        name: "audit",
        beforeToolCall(ctx) {
          if (ctx.event.toolName === "read") expect(ctx.event.input).toEqual({ path: "safe.txt" });
          return { action: "allow" };
        },
        onToolResult(ctx) {
          if (ctx.event.toolName === "read") observerContent = ctx.event.content;
        },
        onNodeExit(ctx) { trace = ctx.decisions.list(); },
      },
    ];
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "tool pipeline",
      async execute(_instance, _input, ctx) { return ctx.runAgent({ prompt: "go" }); },
    };

    await loop.executeGraph(graph, { source: "command", args: "" });

    expect(executedInput).toEqual({ path: "safe.txt" });
    expect(modelContent).toEqual([{ type: "text", text: "[redacted]" }]);
    expect(observerContent).toEqual([{ type: "text", text: "[redacted]" }]);
    expect(trace.map((item) => item.decision)).toContain("tool-allow");
  });

  it("deny 阻止工具执行；非法 patch 也按 fail-closed 处理", async () => {
    const pi = fakePi();
    const blocks: string[] = [];
    let readExecuted = false;
    pi.sendMessage.mockImplementation((_message: any, options?: { triggerTurn?: boolean }) => {
      if (!options?.triggerTurn) return;
      queueMicrotask(async () => {
        for (const input of [{ path: "denied" }, { path: 42 }]) {
          const event = { type: "tool_call", toolCallId: String(input.path), toolName: "read", input };
          const results = await pi.emitAsync("tool_call", event);
          const block = results.find((item: any) => item?.block) as any;
          if (block) blocks.push(block.reason);
          else readExecuted = true;
        }
        await pi.emitAsync("tool_result", {
          type: "tool_result", toolCallId: "complete", toolName: "__graph_complete__", input: {},
          content: [], details: { status: "ok", result: {} }, isError: false,
        });
        await pi.emitAsync("agent_end", { type: "agent_end", messages: [] });
      });
    });
    const loop = createLoopGraphExtension(pi);
    const graph = minimalGraph("phase6_deny");
    graph.mechanisms = [{
      name: "gate",
      beforeToolCall(ctx) {
        if ((ctx.event.input as Record<string, unknown>).path === "denied") {
          return { action: "deny", reason: "not allowed" };
        }
        return { action: "patch", input: { path: 42 } };
      },
    }];
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "deny",
      async execute(_instance, _input, ctx) { return ctx.runAgent({ prompt: "go" }); },
    };

    await loop.executeGraph(graph, { source: "command", args: "" });

    expect(readExecuted).toBe(false);
    expect(blocks[0]).toBe("not allowed");
    expect(blocks[1]).toContain("patch 被拒绝");
  });

  it("ctx.exec 绑定 scope signal、限制 cwd，并截断输出", async () => {
    const pi = fakePi();
    let execSignal: AbortSignal | undefined;
    pi.exec.mockImplementation(async (_command: string, _args: string[], options: any) => {
      execSignal = options.signal;
      return { stdout: "abcdef", stderr: "uvwxyz", code: 0, killed: false };
    });
    let result: any;
    let outsideError = "";
    const loop = createLoopGraphExtension(pi, {
      mechanismRuntime: { execRoot: process.cwd(), execMaxOutputBytes: 4 },
    });
    const graph = minimalGraph("phase6_exec");
    graph.mechanisms = [{
      name: "exec",
      async onNodeEnter(ctx) {
        result = await ctx.exec.run("demo");
        try {
          await ctx.exec.run("demo", [], { cwd: join(process.cwd(), "..") });
        } catch (error) {
          outsideError = error instanceof Error ? error.message : String(error);
        }
      },
    }];

    await loop.executeGraph(graph, { source: "command", args: "" });

    expect(result).toMatchObject({ stdout: "abcd", stderr: "uvwx", stdoutTruncated: true, stderrTruncated: true });
    expect(Object.isFrozen(result)).toBe(true);
    expect(outsideError).toContain("超出受控根目录");
    expect(execSignal?.aborted).toBe(true);
  });
});

describe("Mechanism Phase 7-8 completion gate 与结构化上下文", () => {
  it("异步真实验收可 reject 后重试，并把可信结果与 AI result 分离", async () => {
    const pi = fakePi();
    let turn = 0;
    let execCount = 0;
    let activeValidations = 0;
    let maxActiveValidations = 0;
    let routedCompletion: any;
    pi.exec.mockImplementation(async () => ({
      stdout: execCount++ === 0 ? "tests failed" : "8 tests passed",
      stderr: "",
      code: execCount === 1 ? 1 : 0,
      killed: false,
    }));
    pi.sendMessage.mockImplementation((_message: any, options?: { triggerTurn?: boolean }) => {
      if (!options?.triggerTurn) return;
      const currentTurn = ++turn;
      queueMicrotask(async () => {
        await pi.emitAsync("tool_result", {
          type: "tool_result",
          toolCallId: `complete-${currentTurn}`,
          toolName: "__graph_complete__",
          input: {},
          content: [],
          details: {
            status: "ok",
            result: { testsPassed: 999, verifiedResult: { forged: true } },
          },
          isError: false,
        });
        await pi.emitAsync("agent_end", { type: "agent_end", messages: [] });
      });
    });
    const loop = createLoopGraphExtension(pi);
    const graph = minimalGraph("phase7_async_gate");
    graph.mechanisms = [{
      name: "real-tests",
      async validateCompletion(ctx) {
        activeValidations += 1;
        maxActiveValidations = Math.max(maxActiveValidations, activeValidations);
        try {
          const result = await ctx.exec.run("npm", ["test"]);
          if (result.code !== 0) return { action: "reject", reason: "真实测试未通过" };
          return {
            action: "allow",
            verifiedResult: { exitCode: result.code, output: result.stdout },
          };
        } finally {
          activeValidations -= 1;
        }
      },
    }];
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "run validation",
      async execute(_instance, _input, ctx) { return ctx.runAgent({ prompt: "finish" }); },
    };
    graph.routing.start!.edges[0].guard = (completion) => {
      routedCompletion = completion;
      return true;
    };

    const result = await loop.executeGraph(graph, { source: "command", args: "" });
    expect(result.status).toBe("ok");
    expect(turn).toBe(2);
    expect(maxActiveValidations).toBe(1);
    expect(routedCompletion.result).toMatchObject({
      testsPassed: 999,
      verifiedResult: { forged: true },
    });
    expect(routedCompletion.verifiedResult).toEqual({
      checks: [{
        mechanismName: "real-tests",
        result: { exitCode: 0, output: "8 tests passed" },
      }],
    });
  });

  it("completion gate 的 fail-graph 进入 Runtime 控制路径", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi);
    const graph = minimalGraph("phase7_fail_graph");
    graph.mechanisms = [{
      name: "release-gate",
      validateCompletion() {
        return { action: "fail-graph", reason: "验收基础设施不可用" };
      },
    }];
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "fail graph",
      async execute(_instance, _input, ctx) { return ctx.runAgent({ prompt: "go" }); },
    };

    const result = await loop.executeGraph(graph, { source: "command", args: "" });

    expect(result.status).toBe("failed");
    expect(String(result.result.reason)).toContain("验收基础设施不可用");
  });

  it("completion gate 超时会按 failurePolicy fail-node，不会提前放行", async () => {
    const pi = fakePi();
    const loop = createLoopGraphExtension(pi, {
      mechanismRuntime: { completionValidationTimeoutMs: 5 },
    });
    const graph = minimalGraph("phase7_gate_timeout");
    graph.mechanisms = [{
      name: "hanging-gate",
      failurePolicy: "fail-node",
      validateCompletion() { return new Promise(() => {}); },
    }];
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "timeout",
      async execute(_instance, _input, ctx) { return ctx.runAgent({ prompt: "go" }); },
    };

    const result = await loop.executeGraph(graph, { source: "command", args: "" });

    expect(result.status).toBe("failed");
    expect(String(result.result.reason)).toContain("验收超时");
  });

  it("failed/cancelled completion 默认绕过可信 gate", async () => {
    const pi = fakePi();
    let gateCalls = 0;
    pi.sendMessage.mockImplementation((_message: any, options?: { triggerTurn?: boolean }) => {
      if (!options?.triggerTurn) return;
      queueMicrotask(async () => {
        await pi.emitAsync("tool_result", {
          type: "tool_result", toolCallId: "failed", toolName: "__graph_complete__", input: {},
          content: [], details: { status: "failed", result: { reason: "agent failed" } }, isError: true,
        });
        await pi.emitAsync("agent_end", { type: "agent_end", messages: [] });
      });
    });
    const loop = createLoopGraphExtension(pi);
    const graph = minimalGraph("phase7_non_ok_bypass");
    graph.mechanisms = [{
      name: "only-ok",
      validateCompletion() { gateCalls += 1; return { action: "allow" }; },
    }];
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "failed",
      async execute(_instance, _input, ctx) { return ctx.runAgent({ prompt: "go" }); },
    };

    const result = await loop.executeGraph(graph, { source: "command", args: "" });

    expect(result.status).toBe("failed");
    expect(gateCalls).toBe(0);
  });

  it("ctx.context.append 只发送复制后的 SDK 内容块和固定控制字段", async () => {
    const pi = fakePi();
    const blocks: any[] = [{ type: "text", text: "机制说明", customType: "forged" }];
    const loop = createLoopGraphExtension(pi);
    const graph = minimalGraph("phase8_structured_context");
    graph.mechanisms = [{
      name: "structured",
      onNodeEnter(ctx) {
        expect(ctx.context.append(blocks)).toBe(true);
        blocks[0].text = "被外部修改";
      },
    }];

    await loop.executeGraph(graph, { source: "command", args: "" });

    const call = (pi.sendMessage as any).mock.calls.find(
      (item: any[]) => item[0]?.customType === "loop_graph_mechanism",
    );
    expect(call[0]).toMatchObject({
      customType: "loop_graph_mechanism",
      content: [{ type: "text", text: "机制说明" }],
      display: false,
      details: { protocol: 1 },
    });
    expect(call[0].details.scopeId).toEqual(expect.any(String));
    expect(call[1]).toEqual({});
    expect(call[0].content[0]).not.toHaveProperty("customType");
    expect(Object.isFrozen(call[0].content)).toBe(true);
  });
});

describe("P2 可观测性与外围扩展", () => {
  it("traceSink/logger 收到 graph、node、compaction 生命周期，观测异常不影响执行", async () => {
    const pi = fakePi();
    const events: any[] = [];
    const logger = { debug: vi.fn(), error: vi.fn() };
    const loop = createLoopGraphExtension(pi, {
      traceSink(event) {
        events.push(event);
        if (event.type === "node_enter") throw new Error("sink unavailable");
      },
      logger,
    });
    const graph = minimalGraph("observable_lifecycle");
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "observe",
      async execute() {
        pi.emit("session_compact", { reason: "manual", willRetry: false });
        return { nodeId: "start", status: "ok", result: {} };
      },
    };

    const result = await loop.executeGraph(graph, { source: "command", args: "" });
    const broken = minimalGraph("observable_error");
    broken.nodes.start = {
      kind: "code", id: "start", subGoal: "error",
      async execute() { throw new Error("observable boom"); },
    };
    const failed = await loop.executeGraph(broken, { source: "command", args: "" });

    expect(result.status).toBe("ok");
    expect(failed.status).toBe("failed");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "graph_start", "node_enter", "compaction", "node_exit", "graph_end",
      "graph_error",
    ]));
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
    expect(logger.debug).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("debug 文件输出默认关闭，仅 debug:true 时写入指定 JSONL", async () => {
    const pi = fakePi();
    const directory = mkdtempSync(join(tmpdir(), "loop-graph-trace-"));
    const disabledPath = join(directory, "disabled.jsonl");
    const enabledPath = join(directory, "enabled.jsonl");
    try {
      await createLoopGraphExtension(pi, { debugLogPath: disabledPath })
        .executeGraph(minimalGraph("debug_off"), { source: "command", args: "" });
      expect(existsSync(disabledPath)).toBe(false);

      await createLoopGraphExtension(fakePi(), { debug: true, debugLogPath: enabledPath })
        .executeGraph(minimalGraph("debug_on"), { source: "command", args: "" });
      expect(readFileSync(enabledPath, "utf8")).toContain('"type":"graph_start"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("toolResolver 同时作用于节点激活与工具存在性校验", async () => {
    const pi = fakePi();
    pi.getAllTools.mockReturnValue([
      { name: "read" }, { name: "__graph_complete__" }, { name: "resolved_only" },
    ]);
    const resolver = vi.fn(() => ["resolved_only"]);
    const loop = createLoopGraphExtension(pi, { toolResolver: resolver });
    const graph = minimalGraph("custom_tool_resolver");
    graph.nodes.start = {
      kind: "code", id: "start", subGoal: "resolve", tools: ["unregistered_raw"],
      async execute() { return { nodeId: "start", status: "ok", result: {} }; },
    };

    await expect(loop.executeGraph(graph, { source: "command", args: "" }))
      .resolves.toMatchObject({ status: "ok" });
    expect(pi.setActiveTools).toHaveBeenCalledWith([
      "read", "resolved_only", "__graph_complete__",
    ]);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      graphId: graph.id,
      nodeId: "start",
    }));
  });
});
