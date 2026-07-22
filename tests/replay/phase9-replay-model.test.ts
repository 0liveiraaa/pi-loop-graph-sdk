import { describe, expect, it } from "vitest";
import { exportReplayHtml, parseReplay } from "../../src/replay/index.js";
import type { ReplayDocument } from "../../src/replay/finalizer.js";

function golden(): ReplayDocument {
  const base = { schemaVersion: 1 as const, rootRunId: "root-1", timestamp: "2026-07-22T00:00:00.000Z" };
  return {
    schemaVersion: 1, rootRunId: "root-1", mode: "replay", createdAt: base.timestamp,
    recording: { status: "complete", issues: [] }, totalCost: 0.25,
    result: { rootRunId: "root-1", graphId: "root", graphVersion: "1", steps: 2, durationMs: 12, status: "completed", output: { text: "<script>alert(1)</script>" }, replay: { mode: "replay", status: "complete" } },
    events: [
      { ...base, sequence: 1, event: { domain: "root", type: "root_started" } },
      { ...base, sequence: 2, graphInvocationId: "g-root", event: { domain: "graph", type: "graph_entered", data: { graphId: "root", graphVersion: "1", boundary: "root", depth: 1 } } },
      { ...base, sequence: 3, graphInvocationId: "g-child", event: { domain: "graph", type: "graph_entered", data: { graphId: "child", graphVersion: "1", boundary: "call", parentGraphInvocationId: "g-root", depth: 2 } } },
      { ...base, sequence: 4, graphInvocationId: "g-child", nodeVisitId: "n-1", agentRunId: "a-1", event: { domain: "completion", type: "completion.rejected", data: { reason: "retry" } } },
      { ...base, sequence: 5, graphInvocationId: "g-child", nodeVisitId: "n-1", agentRunId: "a-1", toolCallId: "t-1", event: { domain: "tool", type: "tool_execution_finished", data: { result: "<img src=x onerror=alert(1)>" } } },
      { ...base, sequence: 6, graphInvocationId: "g-child", event: { domain: "compaction", type: "compaction_finished" } },
      { ...base, sequence: 7, event: { domain: "root", type: "root_finished" } },
    ],
  };
}

describe("Phase 9 Replay Model and HTML", () => {
  it("parses JSON into a stable invocation tree and domain summary", () => {
    const model = parseReplay(JSON.stringify(golden()));
    expect(model).toMatchObject({ rootRunId: "root-1", totalCost: 0.25, summary: { root: 2, graph: 2, completion: 1, tool: 1, compaction: 1 } });
    expect(model.unscopedEvents.map((item) => item.event.type)).toEqual(["root_started", "root_finished"]);
    expect(model.invocations).toHaveLength(1);
    expect(model.invocations[0]).toMatchObject({ id: "g-root", graphId: "root", boundary: "root" });
    expect(model.invocations[0].children[0]).toMatchObject({ id: "g-child", parentId: "g-root", graphId: "child", boundary: "call" });
    expect(model.invocations[0].children[0].events.map((item) => item.sequence)).toEqual([3, 4, 5, 6]);
  });

  it("accepts an object, rejects unsupported documents, and detects invocation cycles", () => {
    expect(parseReplay(golden()).rootRunId).toBe("root-1");
    expect(() => parseReplay('{"schemaVersion":2,"events":[]}')).toThrow(/Unsupported/);
    const cyclic = golden();
    const events = cyclic.events.map((event) => event.sequence === 2
      ? { ...event, event: { ...event.event, data: { ...(event.event.data as object), parentGraphInvocationId: "g-child" } } }
      : event);
    expect(() => parseReplay({ ...cyclic, events } as ReplayDocument)).toThrow(/cycle/);
  });

  it("exports one offline HTML document and escapes all replay-controlled text", () => {
    const html = exportReplayHtml(parseReplay(golden()));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Invocation tree");
    expect(html).toContain("completion.rejected");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b|<iframe\b/i);
  });
});
