import { describe, expect, it } from "vitest";
import { projectMessages, stripClosedGraphCalls, type MessageEntry } from "./projection.js";
import type { ContextFrame, Node } from "../type.js";
import type { NodeScopeDescriptor } from "../runtime.js";

const agentNode = (id: string): Node => ({
  kind: "code", id, subGoal: `子目标-${id}`, tools: ["some_tool"],
  execute: async () => ({ nodeId: id, status: "ok", result: {} }),
});

const scope = (nodeId: string, scopeId = `scope-${nodeId}`): NodeScopeDescriptor => ({
  protocol: 2, graphRunId: "run-1", instanceId: "instance-1", scopeId,
  graphId: "graph-1", nodeId, visit: 1, depth: 1,
});

const scopeMessage = (descriptor: NodeScopeDescriptor, content = `=== CURRENT ===\nnodeId: ${descriptor.nodeId}\n=== END ===`): MessageEntry => ({
  customType: "loop_graph_node_scope", content, details: descriptor,
});

const text = (messages: MessageEntry[]) => messages.map((m) =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");

const frame: ContextFrame = {
  nodeId: "node1", status: "ok", summary: "node1 已完成", result: { value: 1 },
};

describe("projectMessages — NodeScope v2", () => {
  it("只保留匹配 NodeScope 及其后的当前节点 live ReAct", () => {
    const oldScope = scope("node1", "scope-old");
    const activeScope = scope("node2", "scope-active");
    const messages: MessageEntry[] = [
      { role: "system", content: "OUTER SYSTEM" },
      { role: "user", content: "OUTER INVOCATION" },
      scopeMessage(oldScope),
      { role: "assistant", content: "old react" },
      { role: "toolResult", content: "old tool result" },
      scopeMessage(activeScope),
      { customType: "loop_graph_prompt", content: "current prompt" },
      { role: "assistant", content: "current react" },
    ];

    const out = projectMessages({ messages, frames: [frame], currentNode: agentNode("node2"), activeScope });
    const projected = text(out);

    expect(projected).toContain("=== COMPLETED ===");
    expect(projected).toContain("node1 已完成");
    expect(projected).toContain("=== CURRENT ===");
    expect(projected).toContain("current prompt");
    expect(projected).toContain("current react");
    expect(projected).not.toContain("OUTER SYSTEM");
    expect(projected).not.toContain("OUTER INVOCATION");
    expect(projected).not.toContain("old react");
    expect(projected).not.toContain("old tool result");
  });

  it("compaction summary 位于 scope 前时不会重新泄漏", () => {
    const activeScope = scope("node2");
    const out = projectMessages({
      messages: [
        { role: "user", content: "compaction summary containing outer secrets" },
        scopeMessage(activeScope),
        { role: "assistant", content: "live" },
      ],
      frames: [], currentNode: agentNode("node2"), activeScope,
    });
    expect(text(out)).toBe("=== CURRENT ===\nnodeId: node2\n=== END ===\nlive");
  });

  it("同 scopeId 多次出现时取最后一个，兼容 compaction 重建锚点", () => {
    const activeScope = scope("node2");
    const out = projectMessages({
      messages: [scopeMessage(activeScope), { role: "assistant", content: "stale" }, scopeMessage(activeScope), { role: "assistant", content: "fresh" }],
      frames: [], currentNode: agentNode("node2"), activeScope,
    });
    expect(text(out)).not.toContain("stale");
    expect(text(out)).toContain("fresh");
  });

  it("scope 缺失时 fail closed：仅输出 frames 与确定性 CURRENT", () => {
    const out = projectMessages({
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "raw secret" }],
      frames: [frame], currentNode: agentNode("node2"), activeScope: scope("node2", "missing"),
      availableEdges: [{ id: "to_end", description: "结束", priority: 1, target: "END" }],
    });
    const projected = text(out);
    expect(projected).toContain("node1 已完成");
    expect(projected).toContain("=== CURRENT ===");
    expect(projected).toContain("to_end");
    expect(projected).not.toContain("SYS");
    expect(projected).not.toContain("raw secret");
  });

  it("scope 缺失且无当前节点时只输出 frames", () => {
    const out = projectMessages({
      messages: [{ role: "user", content: "raw" }], frames: [frame], currentNode: null,
      activeScope: scope("node2", "missing"),
    });
    expect(text(out)).toContain("node1 已完成");
    expect(text(out)).not.toContain("raw");
    expect(text(out)).not.toContain("=== CURRENT ===");
  });

  it("scope 元数据只用于匹配，不会序列化进可见正文", () => {
    const activeScope = scope("node2", "secret-scope-id");
    const out = projectMessages({ messages: [scopeMessage(activeScope)], frames: [], currentNode: agentNode("node2"), activeScope });
    expect(text(out)).not.toContain("secret-scope-id");
    expect(out[0].details).toEqual(activeScope);
  });

  it("自定义 frameFormatter 与 null 跳过语义保持不变", () => {
    const activeScope = scope("node2");
    const messages = [scopeMessage(activeScope)];
    const custom = projectMessages({ messages, frames: [frame], currentNode: agentNode("node2"), activeScope,
      frameFormatter: (frames) => `[${frames[0].nodeId}] ${frames[0].summary}` });
    expect(text(custom)).toContain("[node1] node1 已完成");
    const skipped = projectMessages({ messages, frames: [frame], currentNode: agentNode("node2"), activeScope,
      frameFormatter: () => null });
    expect(text(skipped)).not.toContain("node1 已完成");
  });

  it("默认 formatter 原样投影开发者自定义 frame，不预设字段", () => {
    const activeScope = scope("node2");
    const customFrame: ContextFrame = {
      findings: ["连接正常", "问题位于事务边界"],
      next: "检查隔离级别",
    };
    const out = projectMessages({
      messages: [scopeMessage(activeScope)],
      frames: [customFrame],
      currentNode: agentNode("node2"),
      activeScope,
    });
    const projected = text(out);
    expect(projected).toContain("事务边界");
    expect(projected).toContain("检查隔离级别");
    expect(projected).not.toContain('"nodeId":"node1"');
  });

  it("compaction 后保留原生 summary、活动 scope 与 recent messages", () => {
    const activeScope = scope("node2");
    const out = projectMessages({
      messages: [
        { role: "compactionSummary", summary: "node1 与 node2 早期工作" },
        { role: "user", content: "kept before scope" },
        scopeMessage(activeScope),
        { role: "assistant", content: "node2 recent" },
      ],
      frames: [],
      currentNode: agentNode("node2"),
      activeScope,
      compactionActive: true,
    });
    expect(out[0].role).toBe("compactionSummary");
    expect(text(out)).toContain("node2 recent");
    expect(text(out)).not.toContain("kept before scope");
  });

  it("活动 scope 被压缩时在 summary 后恢复 CURRENT，且不丢 recent messages", () => {
    const activeScope = scope("node2", "compacted-scope");
    const out = projectMessages({
      messages: [
        { role: "compactionSummary", summary: "node2 前两轮工作" },
        { role: "assistant", content: "kept tool conclusion" },
      ],
      frames: [],
      currentNode: agentNode("node2"),
      activeScope,
      compactionActive: true,
    });
    expect(out[0].role).toBe("compactionSummary");
    expect(text(out)).toContain("=== CURRENT ===");
    expect(text(out)).toContain("kept tool conclusion");
  });

  it("合成 frame 与 recovery CURRENT 消息包含 timestamp", () => {
    const out = projectMessages({ messages: [], frames: [frame], currentNode: agentNode("node2"), activeScope: scope("node2") });
    expect(out).toHaveLength(2);
    expect(out.every((message) => typeof message.timestamp === "number")).toBe(true);
  });
});

describe("projectMessages — Phase 8 scoped mechanism content", () => {
  it("scope anchor 缺失时只恢复当前 scope 的结构化 mechanism 消息", () => {
    const activeScope = scope("node2", "scope-current");
    const out = projectMessages({
      messages: [
        {
          role: "custom", customType: "loop_graph_mechanism",
          content: [{ type: "text", text: "stale" }],
          details: { protocol: 1, scopeId: "scope-old" },
        },
        {
          role: "custom", customType: "loop_graph_mechanism",
          content: [{ type: "text", text: "current" }],
          details: { protocol: 1, scopeId: "scope-current" },
        },
        { role: "assistant", content: "unowned live react" },
      ],
      frames: [],
      currentNode: agentNode("node2"),
      activeScope,
    });

    expect(text(out)).toContain("current");
    expect(text(out)).not.toContain("stale");
    expect(text(out)).not.toContain("unowned live react");
  });

  it("compaction recovery 会过滤其他 scope 的 mechanism 消息", () => {
    const activeScope = scope("node2", "scope-current");
    const out = projectMessages({
      messages: [
        { role: "compactionSummary", summary: "summary" },
        {
          role: "custom", customType: "loop_graph_mechanism", content: "stale",
          details: { protocol: 1, scopeId: "scope-old" },
        },
        {
          role: "custom", customType: "loop_graph_mechanism", content: "current",
          details: { protocol: 1, scopeId: "scope-current" },
        },
        { role: "assistant", content: "recent live" },
      ],
      frames: [],
      currentNode: agentNode("node2"),
      activeScope,
      compactionActive: true,
    });

    expect(out.some((message) => message.role === "compactionSummary" && message.summary === "summary")).toBe(true);
    expect(text(out)).toContain("current");
    expect(text(out)).toContain("recent live");
    expect(text(out)).not.toContain("stale");
  });
});

// ── stripClosedGraphCalls 单元测试 ──

describe("stripClosedGraphCalls", () => {
  const callStart = (callId: string, graphId = "g"): MessageEntry => ({
    customType: "loop_graph_call_start",
    content: `start ${graphId}`,
    display: false,
    details: { protocol: 2, callId, graphRunId: "r1", graphId, boundary: "call" },
  });

  const callEnd = (callId: string): MessageEntry => ({
    customType: "loop_graph_call_end",
    content: "end",
    display: false,
    details: { protocol: 2, callId, graphRunId: "r1", graphId: "g", status: "ok" },
  });

  it("空消息数组返回空", () => {
    expect(stripClosedGraphCalls([])).toEqual([]);
  });

  it("无 call_start/end 时原样返回", () => {
    const msgs: MessageEntry[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(stripClosedGraphCalls(msgs)).toEqual(msgs);
  });

  it("闭合的 call 区段被删除", () => {
    const msgs: MessageEntry[] = [
      { role: "user", content: "before" },
      callStart("c1"),
      { role: "custom", customType: "node_scope", content: "inner", display: false },
      { role: "assistant", content: "inner assistant" },
      callEnd("c1"),
      { role: "user", content: "after" },
    ];
    const result = stripClosedGraphCalls(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "before" });
    expect(result[1]).toEqual({ role: "user", content: "after" });
  });

  it("未闭合的 call_start 保留（图仍在运行中）", () => {
    const msgs: MessageEntry[] = [
      { role: "user", content: "before" },
      callStart("c1"),
      { role: "custom", customType: "node_scope", content: "active inner", display: false },
      { role: "assistant", content: "currently running" },
    ];
    const result = stripClosedGraphCalls(msgs);
    expect(result).toHaveLength(4); // all messages preserved
    expect(result[1]).toEqual(callStart("c1"));
    expect(result[3]).toEqual({ role: "assistant", content: "currently running" });
  });

  it("嵌套闭合 call 全部清洗", () => {
    const msgs: MessageEntry[] = [
      { role: "user", content: "outer before" },
      callStart("outer"),
      { role: "custom", customType: "node_scope", content: "outer node", display: false },
      callStart("inner"),
      { role: "custom", customType: "node_scope", content: "inner node", display: false },
      callEnd("inner"),
      callEnd("outer"),
      { role: "user", content: "outer after" },
    ];
    const result = stripClosedGraphCalls(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "outer before" });
    expect(result[1]).toEqual({ role: "user", content: "outer after" });
  });

  it("嵌套中仅内层闭合时只删除内层", () => {
    const msgs: MessageEntry[] = [
      callStart("outer"),
      { role: "custom", customType: "n", content: "outer running", display: false },
      callStart("inner"),
      { role: "custom", customType: "n", content: "inner done", display: false },
      callEnd("inner"),
      { role: "custom", customType: "n", content: "back to outer", display: false },
    ];
    const result = stripClosedGraphCalls(msgs);
    expect(text(result)).toContain("outer running");
    expect(text(result)).toContain("back to outer");
    expect(text(result)).not.toContain("inner done");
  });

  it("多次独立图调用各自闭合后全部清洗", () => {
    const msgs: MessageEntry[] = [
      callStart("c1"),
      { role: "custom", customType: "n", content: "run1", display: false },
      callEnd("c1"),
      { role: "user", content: "between" },
      callStart("c2"),
      { role: "custom", customType: "n", content: "run2", display: false },
      callEnd("c2"),
    ];
    const result = stripClosedGraphCalls(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "between" });
  });

  it("异常状态（有 start 无 end + 有 end 无 start）正确保留未闭合区段", () => {
    const msgs: MessageEntry[] = [
      callStart("open"),
      { role: "custom", customType: "n", content: "open inner", display: false },
      callEnd("orphan"), // 无匹配 start → 不影响清洗
    ];
    const result = stripClosedGraphCalls(msgs);
    // open 未闭合 → 全部保留（包括 orphan end）
    expect(result).toHaveLength(3);
    expect(text(result)).toContain("open inner");
    // orphan end 也在保留的消息中（不匹配任何 start，不触发删除）
    const hasOrphanEnd = result.some(
      (m) => m.customType === "loop_graph_call_end" && (m.details as any)?.callId === "orphan",
    );
    expect(hasOrphanEnd).toBe(true);
  });

  it("callId 精确匹配，不同 callId 不混淆", () => {
    const msgs: MessageEntry[] = [
      callStart("a"),
      { role: "custom", customType: "n", content: "A inner", display: false },
      callEnd("b"),   // 不匹配 a 的 start
      callEnd("a"),
    ];
    // callEnd("b") 不匹配任何 start，callEnd("a") 匹配 callStart("a")
    const result = stripClosedGraphCalls(msgs);
    // 区段 [start("a"), end("a")] 被删除；end("b") 不匹配，但其位置在范围内所以也被删
    // 实际上 end("b") 在 start("a") 和 end("a") 之间，所以会被删除
    expect(result).toHaveLength(0);
  });
});
