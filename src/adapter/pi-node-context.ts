// ============================================================
//  PiNodeContext — Promise 桥接（简化版）
// ============================================================
//
//  不注入 entry message（投影钩子负责），只做两件事：
//    1. 发送 prompt + triggerTurn
//    2. 等待 agent_end 返回 NodeCompletion
//
//  如何获取 NodeCompletion：
//    - agent 调用 __graph_complete__ 工具
//    - extension.ts 的 tool_result 钩子捕获参数 → recordCompletion()
//    - extension.ts 的 agent_end 钩子 → onAgentEnd() → resolve Promise
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NodeCompletion, NodeContext, NodeInput } from "../type.js";
import type { AgentRunRequest } from "../type.js";

export class PiNodeContext implements NodeContext {
  readonly signal: AbortSignal;

  private pi: ExtensionAPI;
  private currentNodeId: string | null = null;

  /** __graph_complete__ 捕获的 completion */
  private pendingCompletion: NodeCompletion | null = null;

  /** 活跃 run 的 resolve */
  private activeResolve: ((c: NodeCompletion) => void) | null = null;
  private activeRunId = 0;
  private nextRunId = 1;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.signal = new AbortController().signal;
  }

  // ── NodeContext 接口 ──────────────────────────────────

  async runAgent(request: AgentRunRequest): Promise<NodeCompletion> {
    const runId = this.nextRunId++;
    this.activeRunId = runId;

    const promise = new Promise<NodeCompletion>((res) => {
      const timeout = setTimeout(() => {
        if (this.activeRunId !== runId) return;
        this.activeRunId = 0;
        this.activeResolve = null;
        res({
          nodeId: this.currentNodeId ?? "unknown",
          status: "failed",
          result: { reason: "Agent run timed out after 5 minutes" },
        });
      }, 5 * 60 * 1000);

      this.activeResolve = (c: NodeCompletion) => {
        clearTimeout(timeout);
        this.activeRunId = 0;
        res(c);
      };
    });

    // 发送 prompt，触发 agent 运行
    this.pi.sendMessage(
      {
        customType: "loop_graph_prompt",
        content: request.prompt,
        display: false,
      },
      { triggerTurn: true },
    );

    try {
      return await promise;
    } catch (error) {
      return {
        nodeId: this.currentNodeId ?? "unknown",
        status: "failed",
        result: {
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async callTool(
    _name: string,
    _input: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error("PiNodeContext.callTool 尚未实现");
  }

  // ── 供 extension.ts 调用 ──────────────────────────────

  recordCompletion(params: {
    status: "ok" | "failed" | "cancelled";
    result: Record<string, unknown>;
  }): void {
    this.pendingCompletion = {
      nodeId: this.currentNodeId ?? "unknown",
      status: params.status,
      result: params.result,
    };
  }

  onAgentEnd(): void {
    if (this.activeRunId === 0) return;
    const resolve = this.activeResolve;
    if (!resolve) return;

    if (this.pendingCompletion) {
      resolve(this.pendingCompletion);
    } else {
      resolve({
        nodeId: this.currentNodeId ?? "unknown",
        status: "failed",
        result: {
          reason: "Agent finished without calling __graph_complete__.",
        },
      });
    }

    this.activeResolve = null;
    this.activeRunId = 0;
  }

  setCurrentNodeId(nodeId: string): void {
    this.currentNodeId = nodeId;
  }

  reset(): void {
    this.currentNodeId = null;
    this.pendingCompletion = null;
    this.activeRunId = 0;
    this.activeResolve = null;
  }
}
