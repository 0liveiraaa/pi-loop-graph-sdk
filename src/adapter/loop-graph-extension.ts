import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRunRequest, CompletionSubmissionDecision } from "../type.js";
import type { Graph as CoreGraph } from "../core/graph.js";
import type { JsonValue } from "../core/json.js";
import type { ContextSnapshot } from "../core/context.js";
import type { Mechanism } from "../core/mechanism.js";
import type { GraphRunResult as CoreGraphRunResult } from "../core/result.js";
import type { InvocationLimits } from "../core/limits.js";
import type { RecordingMode } from "../core/result.js";
import { GraphRuntime as CoreGraphRuntime } from "../runtime/graph-runtime.js";
import { RuntimeEventBus } from "../runtime/event-bus.js";
import { GraphCatalog } from "../host/graph-catalog.js";
import { preflightGraphCapabilities } from "../host/preflight.js";
import type { HostBaseline } from "../host/baseline.js";
import type { SkillCatalog } from "../host/skill-catalog.js";
import { ToolCatalog, type UnsafeToolResolver } from "../host/tool-catalog.js";
import { CONTEXT_SNAPSHOT_MESSAGE_TYPE, PiNodeContext } from "./pi-node-context.js";
import { COMPLETE_TOOL_NAME, createCompleteTool } from "./complete-tool.js";
import {
  defaultModelMessageFormatter,
  type ModelMessageFormatter,
} from "./model-messages.js";
import { probeGraph } from "../graphs/probe-graph.js";
import { chainGraph } from "../graphs/chain-graph.js";
import { childGraph, subgraphGraph } from "../graphs/subgraph-graph.js";
import { reviewGraph } from "../graphs/review-graph.js";
import { validateGraph as validateTestGraph } from "../graphs/validate-graph.js";
import type { NodeContextRenderer } from "./projection.js";
import type { GraphRef } from "../core/graph.js";
import { OUTPUT_CONTRACT_MESSAGE_TYPE } from "./output-contract.js";
import { FileRunStore, type RunStore } from "../replay/store.js";
import { Recorder, toRecordedJson } from "../replay/recorder.js";
import type { PricingResolver, ReplayEvent, ReplayEventScope } from "../replay/events.js";
import type { InvocationAgentHost, InvocationAgentHostRequest } from "../runtime/graph-runtime.js";

const completeToolRegistered = new WeakSet<object>();

export interface LoopGraphLimits {
  readonly rootMaxSteps?: number;
  readonly childMaxSteps?: number;
  readonly agentRunTimeoutMs?: number;
  readonly completionValidationTimeoutMs?: number;
}

export interface ContextRendererRegistry {
  readonly graphs?: Readonly<Record<string, NodeContextRenderer>>;
  readonly nodes?: Readonly<Record<string, Readonly<Record<string, NodeContextRenderer>>>>;
}

export interface LoopGraphExecutionOptions {
  readonly contextRenderer?: NodeContextRenderer;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<InvocationLimits>;
  readonly maxSteps?: number;
  readonly recording?: RecordingMode;
  readonly recordingRequired?: boolean;
}

export interface CompletionFeedbackInput {
  readonly nodeId: string;
  readonly decision: CompletionSubmissionDecision;
}

export type CompletionFeedbackFormatter = (input: CompletionFeedbackInput) => string;

export const defaultCompletionFeedbackFormatter: CompletionFeedbackFormatter = ({ decision }) => {
  if (decision.decision === "accepted") {
    if (decision.validation === "passed") return "节点结果已通过检查并接受。";
    return decision.completionStatus === "failed" ? "Agent 报告当前节点失败。" : "Agent 报告当前节点取消。";
  }
  if (decision.decision === "rejected") return `节点结果未被接受：${decision.reason}`;
  return `${decision.scope === "graph" ? "图" : "节点"}验收失败：${decision.reason}`;
};

export interface LoopGraphExtensionOptions {
  readonly runtimeOnly?: boolean;
  readonly demoGraphs?: boolean;
  readonly toolCatalog?: ToolCatalog;
  readonly skillCatalog?: SkillCatalog;
  readonly unsafeToolResolver?: UnsafeToolResolver;
  readonly baseline?: HostBaseline;
  readonly limits?: LoopGraphLimits;
  readonly outputContractMaxBytes?: number;
  readonly contextMaxBytes?: number;
  readonly mechanisms?: readonly Mechanism[];
  readonly modelMessageFormatter?: Partial<ModelMessageFormatter>;
  readonly completionFeedbackFormatter?: CompletionFeedbackFormatter;
  readonly recording?: RecordingMode;
  readonly recordingRequired?: boolean;
  readonly runStore?: RunStore;
  readonly artifactThresholdBytes?: number;
  readonly pricingResolver?: PricingResolver;
  readonly createInvocationAgentHost?: (
    request: InvocationAgentHostRequest,
    recorder: Recorder | null,
  ) => Promise<InvocationAgentHost>;
}

export interface LoopGraphExtension {
  registerGraph(graph: CoreGraph): void;
  exposeGraph(ref: GraphRef, exposure: GraphExposure): void;
  executeGraph(
    graph: CoreGraph,
    trigger:
      | { readonly source: "command"; readonly args?: string; readonly params?: Record<string, unknown> }
      | { readonly source: "tool"; readonly params?: Record<string, unknown> },
    options?: LoopGraphExecutionOptions,
  ): Promise<CoreGraphRunResult>;
  /** @internal Creates an Agent-only lane; it never owns a GraphRuntime. */
  createAgentHost(recorder?: Recorder | null): InvocationAgentHost;
}

export type GraphExposure =
  | { readonly kind: "command"; readonly name: string; readonly description?: string; readonly parseInput?: (args: string) => JsonValue }
  | { readonly kind: "tool"; readonly name: string; readonly description?: string; readonly parameters?: ToolDefinition["parameters"]; readonly parseInput?: (params: unknown) => JsonValue; readonly formatResult?: (result: CoreGraphRunResult) => unknown };

export function createLoopGraphExtension(
  pi: ExtensionAPI,
  options: LoopGraphExtensionOptions = {},
): LoopGraphExtension {
  const limits = resolveLimits(options.limits);
  const modelMessageFormatter: ModelMessageFormatter = {
    incompleteNode: options.modelMessageFormatter?.incompleteNode ?? defaultModelMessageFormatter.incompleteNode,
    deadRun: options.modelMessageFormatter?.deadRun ?? defaultModelMessageFormatter.deadRun,
    graphFailure: options.modelMessageFormatter?.graphFailure ?? defaultModelMessageFormatter.graphFailure,
  };
  const completionFeedbackFormatter = options.completionFeedbackFormatter ?? defaultCompletionFeedbackFormatter;
  const catalog = new GraphCatalog();
  const piToolCatalog = options.toolCatalog ? new ToolCatalog() : undefined;
  let rootActive = false;
  let activeNodeContext: PiNodeContext | null = null;
  let activeRecorder: Recorder | null = null;

  const recordPiEvent = (event: ReplayEvent, scope?: ReplayEventScope | null): void => {
    if (activeRecorder && scope) activeRecorder.record(event, scope);
  };

  if (!completeToolRegistered.has(pi as object)) {
    pi.registerTool(createCompleteTool());
    completeToolRegistered.add(pi as object);
  }

  pi.on("tool_result", async (event) => {
    const replayScope = activeNodeContext?.getReplayScope();
    recordPiEvent({
      domain: "tool",
      type: "tool_result",
      data: toRecordedJson({ toolName: event.toolName, input: event.input, content: event.content, isError: event.isError }, "forensic"),
    }, replayScope ? { ...replayScope, toolCallId: event.toolCallId } : null);
    if (event.toolName !== COMPLETE_TOOL_NAME || !activeNodeContext) return;
    const params = event.input as Record<string, unknown> | undefined;
    if (!params || Object.keys(params).some((key) => key !== "result") || !isRecord(params.result)) {
      const decision: CompletionSubmissionDecision = {
        decision: "rejected",
        reason: "完成提交只能包含对象类型 result",
      };
      recordPiEvent({ domain: "completion", type: "completion.rejected", data: { reason: decision.reason, validatorStage: "protocol" } }, activeNodeContext.getReplayScope());
      return {
        content: [{ type: "text", text: completionFeedbackFormatter({ nodeId: "?", decision }) }],
        details: decision,
        isError: true,
      };
    }
    const decision = await activeNodeContext.submitCompletion({
      result: params.result,
    });
    return {
      content: [{ type: "text", text: completionFeedbackFormatter({ nodeId: "?", decision }) }],
      details: decision,
      isError: decision.decision !== "accepted",
    };
  });
  pi.on("agent_end", async () => {
    await activeNodeContext?.onAgentEnd();
  });
  pi.on("turn_start", async (event) => {
    recordPiEvent({ domain: "model", type: "model_turn_started", data: { turn: event.turnIndex } }, activeNodeContext?.getReplayScope());
  });
  pi.on("turn_end", async (event) => {
    const message = event.message as unknown as Record<string, unknown>;
    recordPiEvent({
      domain: "model",
      type: "model_turn_finished",
      data: toRecordedJson({
        turn: event.turnIndex,
        provider: message.provider ?? "unknown",
        model: message.model ?? "unknown",
        usage: message.usage ?? {},
        durationMs: message.durationMs,
        retry: message.retry ?? 0,
        message,
        toolResults: event.toolResults,
      }, "forensic"),
    }, activeNodeContext?.getReplayScope());
  });
  pi.on("tool_execution_start", async (event) => {
    const scope = activeNodeContext?.getReplayScope();
    recordPiEvent({ domain: "tool", type: "tool_execution_started", data: toRecordedJson({ toolName: event.toolName, args: event.args }, "forensic") }, scope ? { ...scope, toolCallId: event.toolCallId } : null);
  });
  pi.on("tool_execution_end", async (event) => {
    const scope = activeNodeContext?.getReplayScope();
    recordPiEvent({ domain: "tool", type: "tool_execution_finished", data: toRecordedJson({ toolName: event.toolName, result: event.result, isError: event.isError }, "forensic") }, scope ? { ...scope, toolCallId: event.toolCallId } : null);
  });
  pi.on("session_compact", async (event) => {
    activeNodeContext?.markContextCompacted();
    recordPiEvent({ domain: "compaction", type: "compaction_finished", data: toRecordedJson(event, "forensic") }, activeNodeContext?.getReplayScope());
  });
  pi.on("context", async (event) => {
    if (event.messages.some((item) => item.role === "compactionSummary")) {
      activeNodeContext?.markContextCompacted();
    }
    const message = activeNodeContext?.getContextSnapshotMessage();
    const contract = activeNodeContext?.getActiveOutputContractMessage();
    const messages = event.messages.filter((item) => !(
      item.role === "custom" && (
        item.customType === CONTEXT_SNAPSHOT_MESSAGE_TYPE || item.customType === OUTPUT_CONTRACT_MESSAGE_TYPE
      )
    ));
    if (message) {
      recordPiEvent({ domain: "context", type: "context_snapshot_projected", data: toRecordedJson(message, "forensic") }, activeNodeContext?.getReplayScope());
    }
    return { messages: [message, contract, ...messages].filter(Boolean) as any[] };
  });
  if (!options.runtimeOnly) {
    pi.on("session_start", async (_event, context) => {
      context.ui.notify("Loop Graph Extension 已加载", "info");
    });
  }

  if (options.demoGraphs) {
    for (const graph of [reviewGraph, probeGraph, chainGraph, childGraph, subgraphGraph, validateTestGraph]) {
      registerCoreGraph(graph);
    }
  }

  function registerCoreGraph(graph: CoreGraph): void {
    syncPiBusinessTools(options.toolCatalog, piToolCatalog, pi);
    preflightGraphCapabilities(graph, { ...options, toolCatalog: piToolCatalog });
    catalog.register(graph);
  }

  async function executeGraph(
    graph: CoreGraph,
    trigger: { readonly source: string; readonly args?: string; readonly params?: Record<string, unknown> },
    executionOptions: LoopGraphExecutionOptions = {},
  ): Promise<CoreGraphRunResult> {
    if (rootActive) throw new Error("同一 LoopGraphExtension instance 不支持并发 root executeGraph；请使用独立 Host");
    rootActive = true;
    const previousTools = saveActiveTools(pi);
    const previousContext = activeNodeContext;
    const previousRecorder = activeRecorder;
    const eventBus = new RuntimeEventBus();
    const recording = executionOptions.recording ?? options.recording ?? "replay";
    const recorder = recording === "off" ? null : new Recorder({
      mode: recording,
      store: options.runStore ?? new FileRunStore(),
      artifactThresholdBytes: options.artifactThresholdBytes,
      pricingResolver: options.pricingResolver,
    });
    recorder?.attach(eventBus);
    activeRecorder = recorder;
    const nodeContext = new PiNodeContext(
      pi,
      limits.agentRunTimeoutMs,
      modelMessageFormatter,
      limits.completionValidationTimeoutMs,
      options.outputContractMaxBytes,
      (event) => recordPiEvent({
        domain: event.type.startsWith("completion.") ? "completion" : "context",
        type: event.type,
        data: toRecordedJson(event, "forensic"),
      }, nodeContext.getReplayScope()),
    );
    activeNodeContext = nodeContext;
    try {
      syncPiBusinessTools(options.toolCatalog, piToolCatalog, pi);
      const input = trigger.source === "tool" || trigger.params ? (trigger.params ?? {}) : { args: trigger.args ?? "" };
      const runtime = new CoreGraphRuntime({
        eventBus,
        catalog,
        toolCatalog: piToolCatalog,
        skillCatalog: options.skillCatalog,
        unsafeToolResolver: options.unsafeToolResolver,
        baseline: options.baseline,
        maxStickyContextBytes: options.contextMaxBytes,
        mechanisms: options.mechanisms,
        createInvocationAgentHost: options.createInvocationAgentHost
          ? (request) => options.createInvocationAgentHost!(request, activeRecorder)
          : undefined,
        runAgent: (node, _input, context) => {
          pi.setActiveTools(context.tools.map((tool) => tool.name));
          return runPiAgent(node.prompt ?? node.subGoal, node.output, context, nodeContext);
        },
        runAgentFromCode: (request, _node, context) => {
          pi.setActiveTools(context.tools.map((tool) => tool.name));
          return runPiAgent(request.prompt, request.output, context, nodeContext);
        },
      });
      const result = await runtime.execute(graph, input as never, {
        signal: executionOptions.signal,
        limits: executionOptions.limits,
        maxSteps: executionOptions.maxSteps ?? limits.rootMaxSteps,
      }) as CoreGraphRunResult;
      if (!recorder) return result;
      const finalized = await recorder.finalize(result);
      if ((executionOptions.recordingRequired ?? options.recordingRequired) && finalized.replay.status !== "complete") {
        return {
          rootRunId: result.rootRunId,
          graphId: result.graphId,
          graphVersion: result.graphVersion,
          steps: result.steps,
          durationMs: result.durationMs,
          status: "failed",
          replay: finalized.replay,
          failure: {
            code: "persistence-failed",
            phase: "host",
            message: finalized.replay.issues?.join("; ") ?? "Replay recording failed",
            retryable: true,
          },
        };
      }
      return { ...result, replay: finalized.replay } as CoreGraphRunResult;
    } finally {
      nodeContext.reset();
      restoreActiveTools(pi, previousTools);
      activeNodeContext = previousContext;
      activeRecorder = previousRecorder;
      rootActive = false;
    }
  }

  return {
    registerGraph: registerCoreGraph,
    exposeGraph,
    executeGraph,
    createAgentHost,
  };

  function createAgentHost(recorder: Recorder | null = null): InvocationAgentHost {
    const nodeContext = new PiNodeContext(
      pi,
      limits.agentRunTimeoutMs,
      modelMessageFormatter,
      limits.completionValidationTimeoutMs,
      options.outputContractMaxBytes,
      (event) => recordPiEvent({
        domain: event.type.startsWith("completion.") ? "completion" : "context",
        type: event.type,
        data: toRecordedJson(event, "forensic"),
      }, nodeContext.getReplayScope()),
    );
    let disposed = false;
    const run = async (prompt: string, output: unknown, execution: import("../runtime/graph-runtime.js").AgentExecutionContext) => {
      if (disposed) throw new Error("Invocation Agent Host 已释放");
      const previousContext = activeNodeContext;
      const previousRecorder = activeRecorder;
      activeNodeContext = nodeContext;
      activeRecorder = recorder;
      try {
        pi.setActiveTools(execution.tools.map((tool) => tool.name));
        return await runPiAgent(prompt, output, execution, nodeContext);
      } finally {
        activeNodeContext = previousContext;
        activeRecorder = previousRecorder;
      }
    };
    return {
      runAgent: (node, _input, execution) => run(node.prompt ?? node.subGoal, node.output, execution),
      runAgentFromCode: (request, _node, execution) => run(request.prompt, request.output, execution),
      dispose() {
        if (disposed) return;
        disposed = true;
        nodeContext.reset();
      },
    };
  }

  function exposeGraph(ref: GraphRef, exposure: GraphExposure): void {
    const graph = catalog.resolve(ref);
    if (!graph) throw new Error(`Graph not registered: ${ref.id}@${ref.version}`);
    if (exposure.kind === "command") {
      pi.registerCommand(exposure.name, {
        description: exposure.description,
        async handler(args) {
          await executeGraph(graph, { source: "command", params: (exposure.parseInput?.(args) ?? { args }) as Record<string, unknown> });
        },
      });
      return;
    }
    pi.registerTool({
      name: exposure.name,
      label: exposure.name,
      description: exposure.description ?? exposure.name,
      parameters: exposure.parameters ?? Type.Record(Type.String(), Type.Unknown()),
      async execute(_toolCallId, params) {
        const result = await executeGraph(graph, { source: "tool", params: (exposure.parseInput?.(params) ?? params) as Record<string, unknown> });
        const formatted = exposure.formatResult?.(result) ?? result;
        return { content: [{ type: "text", text: typeof formatted === "string" ? formatted : JSON.stringify(formatted) }], details: formatted };
      },
    });
  }

  async function runPiAgent(
    prompt: string,
    outputSchema: unknown,
    execution: import("../runtime/graph-runtime.js").AgentExecutionContext,
    context: PiNodeContext,
  ): Promise<JsonValue> {
    const stageId = execution.nodeVisit.stageId;
    context.setCurrentNodeId(stageId);
    context.setContextSnapshot(execution.snapshot);
    context.setNodeCompletionValidator(async (result) => {
      const validation = await execution.validateNodeCompletion(result as JsonValue);
      return validation.valid ? { isValid: true } : { isValid: false, reason: validation.reason ?? "Node completion rejected" };
    });
    context.setRouteCompletionValidator(async (result) => {
      const validation = await execution.validateRouteStructure(result as JsonValue);
      return validation.valid ? { isValid: true } : { isValid: false, reason: validation.reason ?? "Route structure rejected" };
    });
    context.setMechanismLifecycle({
      beforeAgentRun: async () => ({ blocked: false }),
      validateCompletion: async (_agentRunId, completion) => {
        const decision = await execution.validateMechanismCompletion(completion.result as JsonValue);
        return decision.action === "allow"
          ? { action: "allow" }
          : { action: decision.action, reason: decision.reason };
      },
      afterAgentRun: () => undefined,
    });
    context.setPostMechanismCompletionValidator(async (result) => {
      const validation = await execution.validateAgentChoice(result as JsonValue);
      return validation.valid ? { isValid: true } : { isValid: false, reason: validation.reason ?? "Agent choice rejected" };
    });
    try {
      const completion = await context.runAgent({
        prompt,
        outputSchema: outputSchema as AgentRunRequest["outputSchema"],
      });
      return completion.result as JsonValue;
    } finally {
      context.setContextSnapshot(null);
      context.setMechanismLifecycle(null);
    }
  }
}

function resolveLimits(limits: LoopGraphLimits | undefined): Required<LoopGraphLimits> {
  const resolved = {
    rootMaxSteps: limits?.rootMaxSteps ?? 100,
    childMaxSteps: limits?.childMaxSteps ?? 50,
    agentRunTimeoutMs: limits?.agentRunTimeoutMs ?? 300_000,
    completionValidationTimeoutMs: limits?.completionValidationTimeoutMs ?? 60_000,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function saveActiveTools(pi: ExtensionAPI): string[] {
  try { return pi.getActiveTools(); } catch { return []; }
}

function restoreActiveTools(pi: ExtensionAPI, tools: string[]): void {
  pi.setActiveTools(tools);
}

function syncPiBusinessTools(
  catalog: ToolCatalog | undefined,
  available: ToolCatalog | undefined,
  pi: ExtensionAPI,
): void {
  if (!catalog || !available) return;
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  for (const name of catalog.names) {
    const tool = catalog.resolve(name);
    if (!tool || available.has(name)) continue;
    if (registered.has(name)) {
      available.register(tool);
      continue;
    }
    if (!tool.execute) continue;
    const definition: ToolDefinition = {
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.parameters ?? Type.Record(Type.String(), Type.Unknown()),
      async execute(_toolCallId, params, signal, onUpdate, context) {
        const result = await tool.execute!(params, signal, onUpdate, context);
        if (isAgentToolResult(result)) return result;
        const text = typeof result === "string" ? result : (JSON.stringify(result) ?? String(result));
        return {
          content: [{ type: "text", text }],
          details: result,
        };
      },
    };
    pi.registerTool(definition);
    registered.add(name);
    available.register(tool);
  }
}

function isAgentToolResult(value: unknown): value is Awaited<ReturnType<ToolDefinition["execute"]>> {
  return isRecord(value) && Array.isArray(value.content);
}
