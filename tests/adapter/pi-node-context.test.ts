import { describe, expect, it, vi } from "vitest";
import { createCompleteTool } from "../../src/adapter/complete-tool.js";
import { PiNodeContext } from "../../src/adapter/pi-node-context.js";

function fakePi() {
  const sent: Array<{ message: any; options: any }> = [];
  return {
    on: vi.fn(),
    sendMessage: vi.fn((message: any, options?: any) => {
      sent.push({ message, options });
    }),
    _sent: sent,
  } as any;
}

describe("PiNodeContext 模型可见恢复消息 characterization", () => {
  it("按 outputSchema → request validator → node validator 顺序校验", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    const order: string[] = [];
    ctx.setCurrentNodeId("schema-node");
    ctx.setNodeCompletionValidator((result) => {
      order.push("node");
      return result.nodeOk === true ? { isValid: true } : { isValid: false, reason: "node invalid" };
    });
    const run = ctx.runAgent({
      prompt: "schema",
      outputSchema: {
        type: "object",
        properties: { value: { type: "number" }, nodeOk: { type: "boolean" } },
        required: ["value", "nodeOk"],
      },
      async validateCompletion(result) {
        await Promise.resolve();
        order.push("request");
        return result.value === 1 ? { isValid: true } : { isValid: false, reason: "request invalid" };
      },
    });

    ctx.recordCompletion({ status: "ok", result: {} });
    await ctx.onAgentEnd();
    expect(order).toEqual([]);
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining("输出不符合 outputSchema") }),
      { triggerTurn: true },
    );

    ctx.recordCompletion({ status: "ok", result: { value: 1, nodeOk: true } });
    await ctx.onAgentEnd();
    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(order).toEqual(["request", "node"]);
  });

  it("非法 outputSchema 在占用 active run 前失败", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("bad-schema");
    await expect(ctx.runAgent({ prompt: "bad", outputSchema: 42 }))
      .rejects.toThrow();
    await ctx.onAgentEnd();
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ customType: "loop_graph_dead" }),
      {},
    );
  });

  it("支持自定义 retry、incomplete 和 dead-run 文案", async () => {
    const pi = fakePi();
    const formatter = {
      validationRetry: ({ reason }: any) => `RETRY:${reason}`,
      incompleteNode: ({ nodeId }: any) => `INCOMPLETE:${nodeId}`,
      deadRun: ({ nodeId }: any) => `DEAD:${nodeId ?? "none"}`,
      graphFailure: () => "GRAPH",
    };
    const ctx = new PiNodeContext(pi, 1000, formatter);
    ctx.setCurrentNodeId("custom-message");
    const run = ctx.runAgent({ prompt: "x", validateCompletion: () => ({ isValid: false, reason: "bad" }) });
    ctx.recordCompletion({ status: "ok", result: {} });
    await ctx.onAgentEnd();
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "RETRY:bad" }),
      { triggerTurn: true },
    );
    await ctx.onAgentEnd();
    await expect(run).resolves.toMatchObject({ result: { reason: "INCOMPLETE:custom-message" } });
    await ctx.onAgentEnd();
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "DEAD:custom-message" }),
      {},
    );
  });

  it("验证失败使用固定 retry 文案并触发下一轮", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("review");
    const run = ctx.runAgent({
      prompt: "review",
      validateCompletion: (result) => result.valid === true
        ? { isValid: true }
        : { isValid: false, reason: "缺少 valid" },
    });

    ctx.recordCompletion({ status: "ok", result: {} });
    await ctx.onAgentEnd();

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "loop_graph_retry",
        content: "验证未通过: 缺少 valid\n请修正后再次调用 __graph_complete__",
        display: false,
      }),
      { triggerTurn: true },
    );

    ctx.recordCompletion({ status: "ok", result: { valid: true } });
    await ctx.onAgentEnd();
    await expect(run).resolves.toMatchObject({ status: "ok", result: { valid: true } });
  });

  it("未调用 complete 时返回固定失败 reason", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("draft");
    const run = ctx.runAgent({ prompt: "draft" });
    await ctx.onAgentEnd();
    await expect(run).resolves.toEqual({
      nodeId: "draft",
      status: "failed",
      result: { reason: "Agent finished without calling __graph_complete__." },
    });
  });

  it("同一 run 内重复 completion 会去重", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("dedupe");
    const run = ctx.runAgent({ prompt: "dedupe" });
    ctx.recordCompletion({ status: "ok", result: { value: 1 } });
    ctx.recordCompletion({ status: "ok", result: { value: 1 } });

    await ctx.onAgentEnd();

    await expect(run).resolves.toEqual({
      nodeId: "dedupe",
      status: "ok",
      result: { value: 1 },
    });
  });

  it("无活动 run 的 agent_end 追加固定 dead-run 消息", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    await ctx.onAgentEnd();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "loop_graph_dead",
        content: "[系统] 当前图已终止，你的后续操作不会被接收。",
      }),
      {},
    );
  });

  it("自定义 agentRunTimeoutMs 控制超时", async () => {
    vi.useFakeTimers();
    try {
      const pi = fakePi();
      const ctx = new PiNodeContext(pi, 25);
      ctx.setCurrentNodeId("slow");
      const run = ctx.runAgent({ prompt: "slow" });
      await vi.advanceTimersByTimeAsync(25);
      await expect(run).resolves.toEqual({
        nodeId: "slow",
        status: "failed",
        result: { reason: "Agent run timed out after 25 ms" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("默认 timeout 保持 5 minutes 兼容文案", async () => {
    vi.useFakeTimers();
    try {
      const pi = fakePi();
      const ctx = new PiNodeContext(pi);
      ctx.setCurrentNodeId("slow-default");
      const run = ctx.runAgent({ prompt: "slow" });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await expect(run).resolves.toMatchObject({
        result: { reason: "Agent run timed out after 5 minutes" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("completion tool characterization", () => {
  it("保持固定 ABI 和默认模型反馈文本", async () => {
    const tool = createCompleteTool();
    expect(tool.name).toBe("__graph_complete__");
    expect(tool.parameters).toMatchObject({
      required: ["status", "result"],
      properties: { status: { enum: ["ok", "failed", "cancelled"] } },
    });
    await expect(tool.execute("call", { status: "ok", result: { done: true } } as any, undefined as any, undefined as any, undefined as any))
      .resolves.toEqual({
        content: [{ type: "text", text: "节点完成: ok" }],
        details: { status: "ok", result: { done: true } },
      });
  });
});
