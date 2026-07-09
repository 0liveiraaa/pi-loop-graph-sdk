// ============================================================
//  投影折叠正确性测试（脱离 pi，纯函数）
// ============================================================

import { describe, expect, it } from "vitest";
import { projectMessages, type MessageEntry } from "./projection.js";
import type { ContextFrame, Node } from "../type.js";

const B = "loop_graph_boundary";

const agentNode = (id: string): Node => ({
  kind: "code",
  id,
  subGoal: `子目标-${id}`,
  tools: ["some_tool"],
  execute: async () => ({ nodeId: id, status: "ok", result: {} }),
});

/** 一段模拟的两节点 transcript：node1 已完成，正处于 node2 的 turn */
function twoNodeTranscript(): MessageEntry[] {
  return [
    { role: "system", content: "SYS" },
    { role: "user", content: "/review 二叉树" },
    { customType: B, content: "__node_boundary__:node1:1" },
    { customType: "loop_graph_prompt", content: "开始执行: node1" },
    { role: "assistant", content: "node1 思考…" },
    { role: "toolResult", content: "node1 工具结果" },
    { role: "assistant", content: "node1 __graph_complete__" },
    { role: "toolResult", content: "node1 complete ok" },
    { customType: B, content: "__node_boundary__:node2:2" },
    { customType: "loop_graph_prompt", content: "开始执行: node2" },
    { role: "assistant", content: "node2 正在工作…" },
  ];
}

const asText = (m: MessageEntry) =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content);
const joined = (msgs: MessageEntry[]) => msgs.map(asText).join("\n");

describe("projectMessages 折叠", () => {
  it("第一个节点：无帧、不丢任何东西（frames 为空）", () => {
    const messages: MessageEntry[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "/review" },
      { customType: B, content: "__node_boundary__:node1:1" },
      { customType: "loop_graph_prompt", content: "开始执行: node1" },
      { role: "assistant", content: "node1 工作" },
    ];
    const out = projectMessages({
      messages,
      frames: [],
      currentNode: agentNode("node1"),
      
      nodeMarker: "__node_boundary__:node1:1",
    });

    // 系统提示与原始 invocation 保留
    expect(asText(out[0])).toBe("SYS");
    expect(asText(out[1])).toBe("/review");
    // 无 COMPLETED 段
    expect(joined(out)).not.toContain("=== COMPLETED ===");
    // 有 CURRENT 段
    expect(joined(out)).toContain("=== CURRENT ===");
    // 当前节点的 live 内容还在
    expect(joined(out)).toContain("node1 工作");
    // 哨兵本身被 skip
    expect(joined(out)).not.toContain("__node_boundary__:node1:1");
  });

  it("第二个节点：前序节点 ReAct 被摘要顶替，且上下文变小", () => {
    const messages = twoNodeTranscript();
    const frame1: ContextFrame = {
      nodeId: "node1",
      status: "ok",
      summary: "node1 已出题",
      result: { question: "Q1" },
    };

    const out = projectMessages({
      messages,
      frames: [frame1],
      currentNode: agentNode("node2"),
      
      nodeMarker: "__node_boundary__:node2:2",
    });

    const text = joined(out);

    // 1. 真正的 head（系统提示 + 原始 invocation）保留
    expect(asText(out[0])).toBe("SYS");
    expect(asText(out[1])).toBe("/review 二叉树");

    // 2. node1 的 ReAct 全部消失
    expect(text).not.toContain("node1 思考");
    expect(text).not.toContain("node1 工具结果");
    expect(text).not.toContain("node1 __graph_complete__");
    expect(text).not.toContain("node1 complete ok");

    // 3. node1 被一行摘要顶替
    expect(text).toContain("=== COMPLETED ===");
    expect(text).toContain("node1 已出题");

    // 4. 当前节点 live 内容保留
    expect(text).toContain("node2 正在工作");
    expect(text).toContain("=== CURRENT ===");

    // 5. 哨兵不出现在投影里
    expect(text).not.toContain("__node_boundary__");

    // 6. 上下文确实变小（投影消息数 < 原始）
    expect(out.length).toBeLessThan(messages.length);
  });

  it("nodeMarker 未匹配时退化：摘要追加末尾，系统提示仍在最前", () => {
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
      
      nodeMarker: "__node_boundary__:missing:9",
    });

    // 系统提示保持在最前，不被插到前面
    expect(asText(out[0])).toBe("SYS");
    expect(asText(out[1])).toBe("hi");
    // 摘要追加在末尾
    expect(asText(out[out.length - 1])).toContain("=== COMPLETED ===");
  });

  it("合成消息带 timestamp（满足 UserMessage 类型契约）", () => {
    const out = projectMessages({
      messages: [{ customType: B, content: "__node_boundary__:node1:1" }],
      frames: [{ nodeId: "n1", status: "ok", summary: "s", result: {} }],
      currentNode: agentNode("node1"),
      
      nodeMarker: "__node_boundary__:node1:1",
    });
    for (const m of out) {
      if (m.role === "user") {
        expect(typeof m.timestamp).toBe("number");
      }
    }
  });

  it("CURRENT 段渲染 agent-choice 可用边列表", () => {
    const out = projectMessages({
      messages: [{ customType: B, content: "__node_boundary__:node1:1" }],
      frames: [],
      currentNode: agentNode("node1"),
      nodeMarker: "__node_boundary__:node1:1",
      availableEdges: [
        { id: "to_archive", description: "答对，归档结果", priority: 10, target: "archive_node" },
        { id: "to_discuss", description: "答错，进入讨论", priority: 10, target: "discuss_node" },
        { id: "to_end", description: "退出复习", priority: 1, target: "END" },
      ],
    });

    const text = joined(out);
    expect(text).toContain("availableEdges");
    expect(text).toContain("to_archive");
    expect(text).toContain("答对，归档结果");
    expect(text).toContain("to_discuss");
    expect(text).toContain("答错，进入讨论");
    expect(text).toContain("chosen_edge_id");
  });

  it("不传 availableEdges 时不渲染该段（向后兼容）", () => {
    const out = projectMessages({
      messages: [{ customType: B, content: "__node_boundary__:node1:1" }],
      frames: [],
      currentNode: agentNode("node1"),
      nodeMarker: "__node_boundary__:node1:1",
    });

    const text = joined(out);
    expect(text).not.toContain("availableEdges");
    expect(text).not.toContain("chosen_edge_id");
  });

  it("空 availableEdges 数组不渲染该段", () => {
    const out = projectMessages({
      messages: [{ customType: B, content: "__node_boundary__:node1:1" }],
      frames: [],
      currentNode: agentNode("node1"),
      nodeMarker: "__node_boundary__:node1:1",
      availableEdges: [],
    });

    const text = joined(out);
    expect(text).not.toContain("availableEdges");
  });
});
