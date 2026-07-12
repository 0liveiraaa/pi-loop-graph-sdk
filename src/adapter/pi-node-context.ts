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
import Schema from "typebox/schema";
import {
  defaultModelMessageFormatter,
  type ModelMessageFormatter,
} from "./model-messages.js";

export interface AgentRunMechanismLifecycle {
  beforeAgentRun(
    agentRunId: number,
    request: AgentRunRequest,
  ): Promise<{ blocked: boolean; reason?: string }>;
  validateCompletion(
    agentRunId: number,
    completion: NodeCompletion,
  ): Promise<
    | { action: "allow"; verifiedResult?: NodeCompletion["verifiedResult"] }
    | { action: "reject" | "fail-node" | "fail-graph"; reason: string }
  >;
  afterAgentRun(agentRunId: number): void;
}

export class PiNodeContext implements NodeContext {
  readonly signal: AbortSignal;

  private pi: ExtensionAPI;
  private currentNodeId: string | null = null;

  /** __graph_complete__ 捕获的 completion 列表（同节点内可能调多次） */
  private pendingCompletions: NodeCompletion[] = [];
  private readonly completionFingerprints = new Set<string>();

  /** 活跃 run 的 resolve */
  private activeResolve: ((c: NodeCompletion) => void) | null = null;
  private activeRunId = 0;
  private nextRunId = 1;
  private readonly agentRunTimeoutMs: number;
  private readonly messageFormatter: ModelMessageFormatter;
  private readonly completionValidationTimeoutMs: number;
  private nodeValidateFn: AgentRunRequest["validateCompletion"] = undefined;
  private postMechanismValidateFn: AgentRunRequest["validateCompletion"] = undefined;
  private mechanismLifecycle: AgentRunMechanismLifecycle | null = null;
  private validationInFlight: Promise<void> | null = null;
  private agentEndQueued = false;

  constructor(
    pi: ExtensionAPI,
    agentRunTimeoutMs = 5 * 60 * 1000,
    messageFormatter: ModelMessageFormatter = defaultModelMessageFormatter,
    completionValidationTimeoutMs = 60_000,
  ) {
    this.pi = pi;
    this.agentRunTimeoutMs = agentRunTimeoutMs;
    this.messageFormatter = messageFormatter;
    this.completionValidationTimeoutMs = completionValidationTimeoutMs;
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
    // schema 配置错误必须在占用 active run 之前抛出，避免把 NodeContext
    // 永久留在一个没有 Promise/timeout 可以收尾的运行状态。
    const validateFn = composeCompletionValidators(
      createSchemaValidator(request.outputSchema),
      request.validateCompletion,
      this.nodeValidateFn,
    );
    this.pendingCompletions = [];
    this.completionFingerprints.clear();
    const runId = this.nextRunId++;
    this.activeRunId = runId;
    this.validateFn = validateFn;

    try {
      const start = this.mechanismLifecycle
        ? await this.mechanismLifecycle.beforeAgentRun(runId, request)
        : undefined;
      if (start?.blocked) {
        this.activeRunId = 0;
        this.validateFn = undefined;
        this.mechanismLifecycle?.afterAgentRun(runId);
        return {
          nodeId: this.currentNodeId ?? "unknown",
          status: "failed",
          result: { reason: start.reason ?? "mechanism 阻止了 agent run" },
        };
      }
    } catch (error) {
      this.activeRunId = 0;
      this.validateFn = undefined;
      this.mechanismLifecycle?.afterAgentRun(runId);
      throw error;
    }

    const promise = new Promise<NodeCompletion>((res) => {
      const timeout = setTimeout(() => {
        if (this.activeRunId !== runId) return;
        this.activeRunId = 0;
        this.activeResolve = null;
        res({
          nodeId: this.currentNodeId ?? "unknown",
          status: "failed",
          result: {
            reason: this.agentRunTimeoutMs === 5 * 60 * 1000
              ? "Agent run timed out after 5 minutes"
              : `Agent run timed out after ${this.agentRunTimeoutMs} ms`,
          },
        });
      }, this.agentRunTimeoutMs);

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
    } finally {
      this.mechanismLifecycle?.afterAgentRun(runId);
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
    const fingerprint = createCompletionFingerprint(params);
    if (this.completionFingerprints.has(fingerprint)) return;
    this.completionFingerprints.add(fingerprint);
    this.pendingCompletions.push({
      nodeId: this.currentNodeId ?? "unknown",
      status: params.status,
      result: params.result,
    });
  }

  onAgentEnd(): Promise<void> {
    if (this.validationInFlight) {
      this.agentEndQueued = true;
      return this.validationInFlight;
    }
    const work = this.processAgentEnd();
    this.validationInFlight = work;
    return work.finally(() => {
      if (this.validationInFlight === work) {
        this.validationInFlight = null;
        if (
          this.agentEndQueued && this.activeRunId !== 0 &&
          this.pendingCompletions.length > 0
        ) {
          this.agentEndQueued = false;
          queueMicrotask(() => { void this.onAgentEnd(); });
        } else {
          this.agentEndQueued = false;
        }
      }
    });
  }

  private async processAgentEnd(): Promise<void> {
    if (this.activeRunId === 0) {
      // 图已终止，agent 仍在跑 → 追加消息告知
      this.pi.sendMessage(
        {
          customType: "loop_graph_dead",
          content: this.messageFormatter.deadRun({ nodeId: this.currentNodeId }),
          display: false,
        },
        {},
      );
      return;
    }
    const resolve = this.activeResolve;
    if (!resolve) return;

    if (this.pendingCompletions.length > 0) {
      const currentCompletions = this.pendingCompletions;
      this.pendingCompletions = [];
      this.completionFingerprints.clear();
      // 取最后一次调用作为主 completion
      const last = currentCompletions[currentCompletions.length - 1];

      // 如果调了多次，把全部记录附在 result 里
      const completion: NodeCompletion = {
        ...last,
        result: {
          ...last.result,
          ...(currentCompletions.length > 1
            ? { allCompletions: currentCompletions }
            : {}),
        },
      };

      // 验证（如果节点声明了 validateCompletion 且 agent 上报 ok）
      if (this.validateFn && completion.status === "ok") {
        const vr = await runCompletionValidator(
          this.validateFn,
          completion.result,
          this.completionValidationTimeoutMs,
        );
        if (!vr.isValid) {
          this.rejectCompletion(vr.reason);
          return;
        }
      }

      if (completion.status === "ok" && this.mechanismLifecycle) {
        const gate = await this.mechanismLifecycle.validateCompletion(
          this.activeRunId,
          completion,
        );
        if (gate.action === "reject") {
          this.rejectCompletion(gate.reason);
          return;
        }
        if (gate.action === "fail-node" || gate.action === "fail-graph") {
          resolve({
            nodeId: this.currentNodeId ?? "unknown",
            status: "failed",
            result: {
              reason: gate.reason,
              completionGate: { action: gate.action },
            },
          });
          return;
        }
        if (gate.action === "allow" && gate.verifiedResult) {
          completion.verifiedResult = gate.verifiedResult;
        }
      }

      if (this.postMechanismValidateFn && completion.status === "ok") {
        const vr = await runCompletionValidator(
          this.postMechanismValidateFn,
          completion.result,
          this.completionValidationTimeoutMs,
        );
        if (!vr.isValid) {
          this.rejectCompletion(vr.reason);
          return;
        }
      }

      resolve(completion);
    } else {
      resolve({
        nodeId: this.currentNodeId ?? "unknown",
        status: "failed",
        result: {
          reason: this.messageFormatter.incompleteNode({
            nodeId: this.currentNodeId ?? "unknown",
            completeToolName: "__graph_complete__",
          }),
        },
      });
    }

    this.activeResolve = null;
    this.activeRunId = 0;
    this.validateFn = undefined;
    this.postMechanismValidateFn = undefined;
  }

  private rejectCompletion(reason: string): void {
    this.pi.sendMessage(
      {
        customType: "loop_graph_retry",
        content: this.messageFormatter.validationRetry({
          nodeId: this.currentNodeId ?? "unknown",
          reason,
          completeToolName: "__graph_complete__",
        }),
        display: false,
      },
      { triggerTurn: true },
    );
    debugLog.agentRetry(this.currentNodeId ?? "?", reason);
  }

  setCurrentNodeId(nodeId: string): void {
    this.currentNodeId = nodeId;
    // 一个 NodeContext 在统一 Runtime 的 callStack 中复用。每次进入节点都
    // 必须切断前一节点（或前一子图）的 completion，节点内多次 runAgent 则不会
    // 再次调用本方法，仍可保留其 allCompletions 语义。
    this.pendingCompletions = [];
    this.completionFingerprints.clear();
    this.validateFn = undefined;
    this.nodeValidateFn = undefined;
    this.postMechanismValidateFn = undefined;
  }

  setNodeCompletionValidator(
    validate: AgentRunRequest["validateCompletion"],
  ): void {
    this.nodeValidateFn = validate;
  }

  setPostMechanismCompletionValidator(
    validate: AgentRunRequest["validateCompletion"],
  ): void {
    this.postMechanismValidateFn = validate;
  }

  setMechanismLifecycle(lifecycle: AgentRunMechanismLifecycle | null): void {
    this.mechanismLifecycle = lifecycle;
  }

  reset(): void {
    this.currentNodeId = null;
    this.pendingCompletions = [];
    this.completionFingerprints.clear();
    this.activeRunId = 0;
    this.activeResolve = null;
    this.validateFn = undefined;
    this.nodeValidateFn = undefined;
    this.postMechanismValidateFn = undefined;
    this.mechanismLifecycle = null;
    this.validationInFlight = null;
    this.agentEndQueued = false;
  }
}

function composeCompletionValidators(
  ...validators: Array<AgentRunRequest["validateCompletion"]>
): AgentRunRequest["validateCompletion"] {
  const active = validators.filter((validator): validator is NonNullable<typeof validator> => validator != null);
  if (active.length === 0) return undefined;
  return async (result) => {
    for (const validator of active) {
      try {
        const validation = await validator(result);
        if (!validation.isValid) return validation;
      } catch (error) {
        return {
          isValid: false,
          reason: `completion validator 异常: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return { isValid: true };
  };
}

async function runCompletionValidator(
  validator: NonNullable<AgentRunRequest["validateCompletion"]>,
  result: Record<string, unknown>,
  timeoutMs: number,
): Promise<import("../type.js").CompletionValidationResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(validator(result)),
      new Promise<import("../type.js").CompletionValidationResult>((resolve) => {
        timeout = setTimeout(() => resolve({
          isValid: false,
          reason: `completion validation timed out after ${timeoutMs} ms`,
        }), timeoutMs);
      }),
    ]);
  } catch (error) {
    return {
      isValid: false,
      reason: `completion validator 异常: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createCompletionFingerprint(params: {
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
}): string {
  try {
    return `${params.status}:${JSON.stringify(params.result)}`;
  } catch {
    return `${params.status}:${String(params.result)}`;
  }
}

function createSchemaValidator(
  outputSchema: unknown,
): AgentRunRequest["validateCompletion"] {
  if (outputSchema == null) return undefined;
  const validator = Schema.Compile(outputSchema as any);
  return (result) => {
    const [isValid, errors] = validator.Errors(result);
    if (isValid) return { isValid: true };
    const summary = errors.slice(0, 3).map((error) => {
      const path = error.instancePath || "$";
      return `${path} ${error.message}`;
    }).join("; ");
    return { isValid: false, reason: `输出不符合 outputSchema: ${summary}` };
  };
}
