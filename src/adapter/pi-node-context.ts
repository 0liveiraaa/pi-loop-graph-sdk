// ============================================================
//  PiNodeContext — Promise 桥接
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
import { debugLog } from "./debug-log.js";

export class PiNodeContext implements NodeContext {
  readonly signal: AbortSignal;

  private pi: ExtensionAPI;
  private currentNodeId: string | null = null;

  /** __graph_complete__ 捕获的 completion 列表（同节点内可能调多次） */
  private pendingCompletions: NodeCompletion[] = [];

  /** 活跃 run 的 resolve */
  private activeResolve: ((c: NodeCompletion) => void) | null = null;
  private activeRunId = 0;
  private nextRunId = 1;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.signal = new AbortController().signal;

    // ── Provider 错误回流通道（单一监听器，生命周期跟实例走）──
    // pi 没有 off，监听器只增不减。挪到构造函数注册一次，
    // 回调读实例当前的 activeRunId/activeResolve，避免闭包泄漏。
    // 排除 429（限流，pi 内部可能重试成功）。
    pi.on("after_provider_response", (event, _ctx) => {
      if (
        event.status >= 400 &&
        event.status !== 429 &&
        this.activeRunId !== 0 &&
        this.activeResolve
      ) {
        this.activeResolve({
          nodeId: this.currentNodeId ?? "unknown",
          status: "failed",
          result: { reason: `Provider error: HTTP ${event.status}` },
        });
      }
    });
  }

  // ── NodeContext 接口 ──────────────────────────────────

  private validateFn: AgentRunRequest["validateCompletion"] = undefined;

  async runAgent(request: AgentRunRequest): Promise<NodeCompletion> {
    const runId = this.nextRunId++;
    this.activeRunId = runId;
    this.validateFn = request.validateCompletion;

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
        this.activeResolve = null;
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

  /**
   * 直接执行 pi 平台上的工具。当前占用位，未实现。
   *
   * 纯代码节点不需要此方法——你可以在 execute 里直接
   * import 并使用任何 Node.js 或第三方库：
   *
   * ```typescript
   * execute: async (instance, input, ctx) => {
   *   const data = fs.readFileSync(input.data.path, "utf-8");
   *   const result = await fetch("https://api.example.com", {...});
   *   return { nodeId: "parse", status: "ok", result: { data, result } };
   * }//讨论在有纯代码节点的前提下该功能是否必要
   * ```
   */
  async callTool(
    _name: string,
    _input: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error(
      "PiNodeContext.callTool 未实现。纯代码节点请直接在 execute 中使用 Node.js API。",
    );
  }

  // ── 供 extension.ts 调用 ──────────────────────────────

  /** 当前节点内调用 __graph_complete__ 的次数 */
  get completeCount(): number {
    return this.pendingCompletions.length;
  }

  recordCompletion(params: {
    status: "ok" | "failed" | "cancelled";
    result: Record<string, unknown>;
  }): void {
    this.pendingCompletions.push({
      nodeId: this.currentNodeId ?? "unknown",
      status: params.status,
      result: params.result,
    });
  }

  onAgentEnd(): void {
    if (this.activeRunId === 0) {
      // 图已终止，agent 仍在跑 → 追加消息告知
      this.pi.sendMessage(
        {
          customType: "loop_graph_dead",
          content: "[系统] 当前图已终止，你的后续操作不会被接收。",
          display: false,
        },
        {},
      );
      return;
    }
    const resolve = this.activeResolve;
    if (!resolve) return;

    if (this.pendingCompletions.length > 0) {
      // 取最后一次调用作为主 completion
      const last = this.pendingCompletions[this.pendingCompletions.length - 1];

      // 如果调了多次，把全部记录附在 result 里
      const completion: NodeCompletion = {
        ...last,
        result: {
          ...last.result,
          ...(this.pendingCompletions.length > 1
            ? { allCompletions: this.pendingCompletions }
            : {}),
        },
      };

      // 验证（如果节点声明了 validateCompletion 且 agent 上报 ok）
      if (this.validateFn && completion.status === "ok") {
        const vr = this.validateFn(completion.result);
        if (!vr.isValid) {
          this.pi.sendMessage(
            {
              customType: "loop_graph_retry",
              content: `验证未通过: ${vr.reason}\n请修正后再次调用 __graph_complete__`,
              display: false,
            },
            { triggerTurn: true },
          );
          debugLog.agentRetry(this.currentNodeId ?? "?", vr.reason);
          this.pendingCompletions = [];
          return;
        }
      }

      resolve(completion);
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
    this.validateFn = undefined;
  }

  setCurrentNodeId(nodeId: string): void {
    this.currentNodeId = nodeId;
    // 一个 NodeContext 在统一 Runtime 的 callStack 中复用。每次进入节点都
    // 必须切断前一节点（或前一子图）的 completion，节点内多次 runAgent 则不会
    // 再次调用本方法，仍可保留其 allCompletions 语义。
    this.pendingCompletions = [];
    this.validateFn = undefined;
  }

  reset(): void {
    this.currentNodeId = null;
    this.pendingCompletions = [];
    this.activeRunId = 0;
    this.activeResolve = null;
    this.validateFn = undefined;
  }
}
