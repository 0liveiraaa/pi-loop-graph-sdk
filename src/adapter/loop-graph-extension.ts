import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRunRequest, CompletionSubmissionDecision } from "../type.js";
import type { Graph as CoreGraph } from "../core/graph.js";
import type { JsonValue } from "../core/json.js";
import type { ContextSnapshot } from "../core/context.js";
import type { Mechanism } from "../core/mechanism.js";
import type { GraphRunResult as CoreGraphRunResult } from "../core/result.js";
import type { InvocationLimits } from "../core/limits.js";
import { GraphRuntime as CoreGraphRuntime } from "../runtime/graph-runtime.js";
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
}

export interface LoopGraphExtension {
  registerGraph(graph: CoreGraph): void;
  executeGraph(
    graph: CoreGraph,
    trigger:
      | { readonly source: "command"; readonly args?: string; readonly params?: Record<string, unknown> }
      | { readonly source: "tool"; readonly params?: Record<string, unknown> },
    options?: LoopGraphExecutionOptions,
  ): Promise<CoreGraphRunResult>;
}

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

  if (!completeToolRegistered.has(pi as object)) {
    pi.registerTool(createCompleteTool());
    completeToolRegistered.add(pi as object);
  }

  pi.on("tool_result", async (event) => {
    if (event.toolName !== COMPLETE_TOOL_NAME || !activeNodeContext) return;
    const params = event.input as Record<string, unknown> | undefined;
    if (!params || !["ok", "failed", "cancelled"].includes(String(params.status)) || !isRecord(params.result)) {
      const decision: CompletionSubmissionDecision = {
        decision: "rejected",
        reason: "完成提交必须包含合法的 status 和对象类型 result",
      };
      return {
        content: [{ type: "text", text: completionFeedbackFormatter({ nodeId: "?", decision }) }],
        details: decision,
        isError: true,
      };
    }
    const decision = await activeNodeContext.submitCompletion({
      status: params.status as "ok" | "failed" | "cancelled",
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
  pi.on("context", async (event) => {
    const message = activeNodeContext?.getContextSnapshotMessage();
    const messages = event.messages.filter((item) => !(
      item.role === "custom" && item.customType === CONTEXT_SNAPSHOT_MESSAGE_TYPE
    ));
    return message ? { messages: [message as any, ...messages] } : { messages };
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
    const nodeContext = new PiNodeContext(
      pi,
      limits.agentRunTimeoutMs,
      modelMessageFormatter,
      limits.completionValidationTimeoutMs,
      options.outputContractMaxBytes,
    );
    activeNodeContext = nodeContext;
    try {
      syncPiBusinessTools(options.toolCatalog, piToolCatalog, pi);
      const input = trigger.source === "tool" || trigger.params ? (trigger.params ?? {}) : { args: trigger.args ?? "" };
      const runtime = new CoreGraphRuntime({
        catalog,
        toolCatalog: piToolCatalog,
        skillCatalog: options.skillCatalog,
        unsafeToolResolver: options.unsafeToolResolver,
        baseline: options.baseline,
        maxStickyContextBytes: options.contextMaxBytes,
        mechanisms: options.mechanisms,
        runAgent: (node, _input, context) => {
          pi.setActiveTools(context.tools.map((tool) => tool.name));
          return runPiAgent(node.prompt ?? node.subGoal, node.output, context.nodeVisit.stageId, context.snapshot, nodeContext);
        },
        runAgentFromCode: (request, _node, context) => {
          pi.setActiveTools(context.tools.map((tool) => tool.name));
          return runPiAgent(request.prompt, request.output, context.nodeVisit.stageId, context.snapshot, nodeContext);
        },
      });
      return await runtime.execute(graph, input as never, {
        signal: executionOptions.signal,
        limits: executionOptions.limits,
        maxSteps: executionOptions.maxSteps ?? limits.rootMaxSteps,
      }) as CoreGraphRunResult;
    } finally {
      nodeContext.reset();
      restoreActiveTools(pi, previousTools);
      activeNodeContext = previousContext;
      rootActive = false;
    }
  }

  return {
    registerGraph: registerCoreGraph,
    executeGraph,
  };

  async function runPiAgent(
    prompt: string,
    outputSchema: unknown,
    stageId: string,
    snapshot: ContextSnapshot,
    context: PiNodeContext,
  ): Promise<JsonValue> {
    context.setCurrentNodeId(stageId);
    context.setContextSnapshot(snapshot);
    try {
      const completion = await context.runAgent({
        prompt,
        outputSchema: outputSchema as AgentRunRequest["outputSchema"],
      });
      return completion.result as JsonValue;
    } finally {
      context.setContextSnapshot(null);
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
