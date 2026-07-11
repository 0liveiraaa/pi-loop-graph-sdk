import { describe, expect, it } from "vitest";
import { projectMessages, type MessageEntry } from "./projection.js";
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

  it("合成 frame 与 recovery CURRENT 消息包含 timestamp", () => {
    const out = projectMessages({ messages: [], frames: [frame], currentNode: agentNode("node2"), activeScope: scope("node2") });
    expect(out).toHaveLength(2);
    expect(out.every((message) => typeof message.timestamp === "number")).toBe(true);
  });
});
