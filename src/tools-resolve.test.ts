// ============================================================
//  resolveNodeTools 单元测试
// ============================================================
//
//  这是全仓库唯一的工具真相源。去重 + 排序两个契约，
//  覆盖所有触发了审查问题 2（无去重 → 400）的边界。
// ============================================================

import { describe, expect, it } from "vitest";
import { resolveNodeTools } from "./tools-resolve.js";

describe("resolveNodeTools", () => {
  // ── 基本合并 ──

  it("合并 defaultTools 和 nodeTools，包上框架工具", () => {
    const result = resolveNodeTools(
      ["global_tool"],
      ["node_tool"],
    );
    expect(result).toEqual([
      "read",
      "global_tool",
      "node_tool",
      "__graph_complete__",
    ]);
  });

  it("defaultTools 为空时只含框架工具 + nodeTools", () => {
    const result = resolveNodeTools([], ["review_card", "review_answer"]);
    expect(result).toEqual([
      "read",
      "review_card",
      "review_answer",
      "__graph_complete__",
    ]);
  });

  it("nodeTools 为空时只含框架工具 + defaultTools", () => {
    const result = resolveNodeTools(["global_tool"], []);
    expect(result).toEqual([
      "read",
      "global_tool",
      "__graph_complete__",
    ]);
  });

  it("两者都为空时只有框架工具", () => {
    const result = resolveNodeTools([], []);
    expect(result).toEqual(["read", "__graph_complete__"]);
  });

  // ── 去重 —— 审查问题 2 的本体 ──

  it("defaultTools 与 nodeTools 重叠时去重，保留首次出现位置", () => {
    const result = resolveNodeTools(
      ["review_card", "review_chapter"],
      ["review_chapter", "review_answer"],
    );
    // review_chapter 首次出现在 defaultTools → 保留该位置
    expect(result).toEqual([
      "read",
      "review_card",
      "review_chapter",
      "review_answer",
      "__graph_complete__",
    ]);
  });

  it("多种工具重叠时全部去重", () => {
    const result = resolveNodeTools(
      ["a", "b", "c"],
      ["b", "c", "d"],
    );
    expect(result).toEqual(["read", "a", "b", "c", "d", "__graph_complete__"]);
  });

  it("defaultTools 之间如有重复也去重（防御性）", () => {
    const result = resolveNodeTools(
      ["dup", "dup"],
      [],
    );
    expect(result).toEqual(["read", "dup", "__graph_complete__"]);
  });

  // ── 排序强制：read 归首 ──

  it("read 总是第一位，即使 defaultTools 中有 read", () => {
    const result = resolveNodeTools(
      ["read", "other"],
      [],
    );
    expect(result[0]).toBe("read");
    // read 不重复出现
    expect(result.filter((t) => t === "read")).toHaveLength(1);
  });

  it("nodeTools 中有 read 时，read 仍在首位且去重", () => {
    const result = resolveNodeTools(
      ["global_tool"],
      ["read", "node_tool"],
    );
    expect(result[0]).toBe("read");
    expect(result.filter((t) => t === "read")).toHaveLength(1);
  });

  // ── 排序强制：__graph_complete__ 归尾 ──

  it("__graph_complete__ 总是最后一位", () => {
    const result = resolveNodeTools(
      ["__graph_complete__", "a"],
      ["b"],
    );
    expect(result[result.length - 1]).toBe("__graph_complete__");
    expect(result.filter((t) => t === "__graph_complete__")).toHaveLength(1);
  });

  it("nodeTools 中有 __graph_complete__ 时仍在末尾且去重", () => {
    const result = resolveNodeTools(
      ["a"],
      ["b", "__graph_complete__"],
    );
    expect(result[result.length - 1]).toBe("__graph_complete__");
    expect(result.filter((t) => t === "__graph_complete__")).toHaveLength(1);
  });

  it("defaultTools 和 nodeTools 同时有 __graph_complete__ 时只保留一个在末尾", () => {
    const result = resolveNodeTools(
      ["__graph_complete__"],
      ["__graph_complete__"],
    );
    expect(result).toEqual(["read", "__graph_complete__"]);
  });

  // ── 稳定性 —— 顺序变化是审查问题 2 的诱因之一 ──

  it("相同输入多次调用返回相同结果", () => {
    const a = resolveNodeTools(["x", "y"], ["z"]);
    const b = resolveNodeTools(["x", "y"], ["z"]);
    expect(a).toEqual(b);
  });

  it("defaultTools 和 nodeTools 的插入顺序不会因为去重而乱序", () => {
    const result = resolveNodeTools(
      ["d1", "d2", "d3"],
      ["n1", "n2"],
    );
    // 应保持：read, d1, d2, d3, n1, n2, __graph_complete__
    expect(result).toEqual([
      "read", "d1", "d2", "d3", "n1", "n2", "__graph_complete__",
    ]);
  });

  it("支持自定义 resolver，同时强制保留 framework tools 首尾边界", () => {
    const seen: any[] = [];
    const result = resolveNodeTools(
      ["global"],
      ["node"],
      (input) => {
        seen.push(input);
        return ["node", "custom", "read", "__graph_complete__", "custom"];
      },
      { graphId: "g", nodeId: "n" },
    );

    expect(result).toEqual(["read", "node", "custom", "__graph_complete__"]);
    expect(seen[0]).toMatchObject({ graphId: "g", nodeId: "n" });
    expect(Object.isFrozen(seen[0].defaultTools)).toBe(true);
  });
});
