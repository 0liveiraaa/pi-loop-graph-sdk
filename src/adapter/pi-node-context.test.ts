import { describe, expect, it, vi } from "vitest";
import { createCompleteTool } from "./complete-tool.js";
import { PiNodeContext } from "./pi-node-context.js";

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
    ctx.onAgentEnd();

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "loop_graph_retry",
        content: "验证未通过: 缺少 valid\n请修正后再次调用 __graph_complete__",
        display: false,
      }),
      { triggerTurn: true },
    );

    ctx.recordCompletion({ status: "ok", result: { valid: true } });
    ctx.onAgentEnd();
    await expect(run).resolves.toMatchObject({ status: "ok", result: { valid: true } });
  });

  it("未调用 complete 时返回固定失败 reason", async () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.setCurrentNodeId("draft");
    const run = ctx.runAgent({ prompt: "draft" });
    ctx.onAgentEnd();
    await expect(run).resolves.toEqual({
      nodeId: "draft",
      status: "failed",
      result: { reason: "Agent finished without calling __graph_complete__." },
    });
  });

  it("无活动 run 的 agent_end 追加固定 dead-run 消息", () => {
    const pi = fakePi();
    const ctx = new PiNodeContext(pi, 1000);
    ctx.onAgentEnd();
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
