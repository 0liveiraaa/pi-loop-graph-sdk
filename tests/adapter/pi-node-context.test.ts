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

describe("PiNodeContext completion submission", () => {
  it("首次 turn 前展示 output contract，并按 schema → request → node 顺序立即校验", async () => {
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

    const rejected = await ctx.submitCompletion({ status: "ok", result: {} });
    expect(rejected).toMatchObject({ decision: "rejected", reason: expect.stringContaining("outputSchema") });
    expect(order).toEqual([]);
    expect(pi._sent[0].message).toMatchObject({
      customType: "loop_graph_output_contract",
      content: expect.stringContaining('"nodeOk"'),
    });
    expect(pi._sent[0].message.content).toContain('"required"');

    await expect(ctx.submitCompletion({ status: "ok", result: { value: 1, nodeOk: true } }))
      .resolves.toMatchObject({ decision: "accepted", validation: "passed" });
    await ctx.onAgentEnd();
    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(order).toEqual(["request", "node"]);
  });

  it("非法 outputSchema 在占用 active run 前失败", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("bad-schema");
    await expect(ctx.runAgent({ prompt: "bad", outputSchema: 42 as any }))
      .rejects.toThrow();
    await ctx.onAgentEnd();
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ customType: "loop_graph_dead" }),
      {},
    );
  });

  it("支持自定义 incomplete 和 dead-run 文案", async () => {
    const pi = fakePi();
    const formatter = {
      incompleteNode: ({ nodeId }: any) => `INCOMPLETE:${nodeId}`,
      deadRun: ({ nodeId }: any) => `DEAD:${nodeId ?? "none"}`,
      graphFailure: () => "GRAPH",
    };
    const ctx = new PiNodeContext(pi, 1000, formatter);
    ctx.setCurrentNodeId("custom-message");
    const run = ctx.runAgent({ prompt: "x" });
    await ctx.onAgentEnd();
    await expect(run).resolves.toMatchObject({ result: { reason: "INCOMPLETE:custom-message" } });
    await ctx.onAgentEnd();
    expect(pi.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "DEAD:custom-message" }),
      {},
    );
  });

  it("验证失败直接返回 rejected，不产生完成信号或额外 turn", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("review");
    const run = ctx.runAgent({
      prompt: "review",
      validateCompletion: (result) => result.valid === true
        ? { isValid: true }
        : { isValid: false, reason: "缺少 valid" },
    });

    await expect(ctx.submitCompletion({ status: "ok", result: {} })).resolves.toEqual({
      decision: "rejected",
      reason: "缺少 valid",
      validatorStage: "agent-run",
      schemaFingerprint: undefined,
    });
    expect(pi._sent).toHaveLength(1);

    await ctx.submitCompletion({ status: "ok", result: { valid: true } });
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
    await expect(ctx.submitCompletion({ status: "ok", result: { value: 1 } }))
      .resolves.toMatchObject({ decision: "accepted" });
    await expect(ctx.submitCompletion({ status: "ok", result: { value: 1 } }))
      .resolves.toMatchObject({ decision: "rejected", reason: "重复提交相同节点结果" });

    await ctx.onAgentEnd();

    await expect(run).resolves.toEqual({
      nodeId: "dedupe",
      status: "ok",
      result: { value: 1 },
    });
  });

  it.each(["failed", "cancelled"] as const)("%s 提交跳过成功校验", async (status) => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    const validator = vi.fn(() => ({ isValid: false as const, reason: "不应执行" }));
    ctx.setCurrentNodeId("terminal-report");
    ctx.setNodeCompletionValidator(validator);
    const run = ctx.runAgent({
      prompt: "terminal",
      outputSchema: {
        type: "object",
        required: ["successOnly"],
        properties: { successOnly: { type: "boolean" } },
      },
      validateCompletion: validator,
    });

    await expect(ctx.submitCompletion({ status, result: { reason: "agent report" } }))
      .resolves.toMatchObject({ decision: "accepted", completionStatus: status, validation: "skipped" });
    await ctx.onAgentEnd();
    await expect(run).resolves.toMatchObject({ status });
    expect(validator).not.toHaveBeenCalled();
  });

  it("同一 Node 的连续 Agent Run 使用各自契约且结束后不残留", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("two-runs");

    const first = ctx.runAgent({
      prompt: "first",
      outputSchema: { type: "object", required: ["first"], properties: { first: { type: "boolean" } } },
    });
    const firstContract = ctx.getActiveOutputContractMessage();
    expect(firstContract?.content).toContain('"first"');
    await ctx.submitCompletion({ status: "ok", result: { first: true } });
    await ctx.onAgentEnd();
    await first;
    expect(ctx.getActiveOutputContractMessage()).toBeNull();

    const second = ctx.runAgent({
      prompt: "second",
      outputSchema: { type: "object", required: ["second"], properties: { second: { type: "number" } } },
    });
    const secondContract = ctx.getActiveOutputContractMessage();
    expect(secondContract?.content).toContain('"second"');
    expect(secondContract?.content).not.toContain('"first"');
    expect((secondContract?.details as any).schemaFingerprint)
      .not.toBe((firstContract?.details as any).schemaFingerprint);
    await ctx.submitCompletion({ status: "ok", result: { second: 2 } });
    await ctx.onAgentEnd();
    await second;
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

describe("completion tool", () => {
  it("只确认提交，不回显模型填写的 status/result", async () => {
    const tool = createCompleteTool();
    expect(tool.name).toBe("__graph_complete__");
    expect(tool.parameters).toMatchObject({
      required: ["status", "result"],
      properties: { status: { enum: ["ok", "failed", "cancelled"] } },
    });
    await expect(tool.execute("call", { status: "ok", result: { done: true } } as any, undefined as any, undefined as any, undefined as any))
      .resolves.toEqual({
        content: [{ type: "text", text: "节点结果已提交，等待检查。" }],
        details: undefined,
      });
  });

  it("UI 只渲染提交动作和 Runtime 决策", () => {
    const tool = createCompleteTool() as any;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const callText = tool.renderCall(
      { status: "ok", result: { secret: "raw" } },
      theme,
      {},
    ).render(100).join("\n");
    expect(callText.trimEnd()).toBe("提交节点结果");
    expect(callText).not.toContain("ok");
    expect(callText).not.toContain("secret");

    const resultText = tool.renderResult({
      details: { decision: "rejected", reason: "缺少 question_id" },
    }, {}, theme, {}).render(100).join("\n");
    expect(resultText).toContain("节点结果未被接受");
    expect(resultText).toContain("缺少 question_id");
  });
});
