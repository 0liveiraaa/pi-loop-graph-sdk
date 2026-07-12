// ============================================================
//  loop-graph-extension.ts — 可实例化的 Loop Graph 运行时工厂
// ============================================================
//
//  每个 createLoopGraphExtension(pi, options?) 返回独立的
//  LoopGraphExtension 实例，持有独立的：
//    · GraphRegistry（图注册表，实例间不互相污染）
//    · activeRuntime / activeNodeContext（运行时状态）
//    · context / tool_result / agent_end 钩子
//
//  业务 extension 使用方式：
//
//    import { createLoopGraphExtension } from "pi-loop-graph-sdk";
//    export default function myExtension(pi) {
//      const loop = createLoopGraphExtension(pi);
//      loop.registerGraph(myBusinessGraph);
//    }
//
//  不再依赖全局 Registry 初始化顺序。
// ============================================================

import type {
  CompactionSettings,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentInstance,
  Edge,
  Graph,
  GraphRunResult,
  Mechanism,
  MechanismContext,
  Node,
  NodeCompletion,
  NodeInput,
} from "../type.js";
import { END } from "../type.js";
import { GraphRuntime } from "../runtime.js";
import { assertValidGraph, validateGraphTools } from "../validate.js";
import { selectEdge } from "../router.js";
import {
  defaultNodeContextRenderer,
  projectMessages,
  stripClosedGraphCalls,
  type EdgeChoice,
  type MessageEntry,
  type NodeContextRenderInput,
  type NodeContextRenderer,
  type RenderedContextContentBlock,
  type RenderedContextMessage,
} from "./projection.js";
import { PiNodeContext } from "./pi-node-context.js";
import { COMPLETE_TOOL_NAME, createCompleteTool } from "./complete-tool.js";
import { resolveNodeTools } from "../tools-resolve.js";
import { debugLog } from "./debug-log.js";
import {
  defaultModelMessageFormatter,
  type ModelMessageFormatter,
} from "./model-messages.js";
import { GraphRegistry } from "../registry.js";
import {
  DelegateGraphInvoker,
  type DelegateHostFactory,
  type GraphInvoker,
} from "./graph-execution-host.js";
import { reviewGraph } from "../graphs/review-graph.js";
import { probeGraph } from "../graphs/probe-graph.js";
import { chainGraph } from "../graphs/chain-graph.js";
import { subgraphGraph } from "../graphs/subgraph-graph.js";
import { validateGraph as validateTestGraph } from "../graphs/validate-graph.js";

import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultSkillContentProvider,
  defaultSkillContentRenderer,
  type SkillContentProvider,
  type SkillContentRenderer,
  type SkillFailurePolicies,
  type SkillLoadContext,
} from "./skill-content.js";

const NODE_SCOPE_TYPE = "loop_graph_node_scope";
const completeToolRegistered = new WeakSet<object>();

// ── 公开 API 类型 ──────────────────────────────────────────

export interface LoopGraphExtensionOptions {
  /** 仅安装执行 Runtime，不注册 session UI 通知或对外 invocation。
   * 供独立子 AgentSession 使用。 */
  runtimeOnly?: boolean;
  /** 是否注册 SDK 自带测试/示例图。默认 false，
   *  只有 debug/demo extension 入口应设为 true。 */
  demoGraphs?: boolean;
  /** 节点内默认可用工具列表。为空时只保留 read + __graph_complete__。
   *  业务 extension 可按需传入全局工具。 */
  defaultTools?: string[];
  /** skill 目录的根路径。node.skill 的 SKILL.md 在此路径下按 `{name}/SKILL.md` 查找。
   *  默认 `process.cwd() + "/skills"`。 */
  skillBasePath?: string;
  /** 自定义帧折叠后注入到 agent 上下文的 COMPLETED 段格式。
   *  接收所有已完成帧（ContextFrame[]），返回完整文本。
   *  返回 null 则跳过 COMPLETED 段（不折叠，agent 看不到历史帧）。
   *  默认：保持当前 JSON 格式（向后兼容）。 */
  frameFormatter?: (frames: import("../type.js").ContextFrame[]) => string | null;
  /** 为 command、tool 和 delegate graph-node 创建一次性隔离执行 host。 */
  createDelegateHost?: DelegateHostFactory;
  /** 传递给递归隔离子会话的真实工具定义。 */
  delegateTools?: ToolDefinition[];
  /** 隔离子会话的 compaction 配置；由 host factory 消费。 */
  delegateCompaction?: CompactionSettings;
  /** graph tool 返回给模型的最大 UTF-8 字节数。 */
  toolResultMaxBytes?: number;
  /** 图循环与单次 agent run 的运行限制。省略时保持兼容默认值。 */
  limits?: LoopGraphLimits;
  /** 自定义 SDK 在 node-enter 时追加给模型的 CURRENT/skill/instruction 载荷。
   * NodeScope、GraphCallScope、compaction 与 frame baseline 仍由 SDK 固定管理。 */
  contextRenderer?: NodeContextRenderer;
  /** 自定义 validation retry、incomplete、dead-run 和 graph failure 文案。 */
  modelMessageFormatter?: Partial<ModelMessageFormatter>;
  /** 自定义 __graph_complete__ 返回给模型的文本；控制 details/ABI 不变。 */
  completionToolResultFormatter?: CompletionToolResultFormatter;
  /** 异步解析 node.skill 引用。默认读取 skillBasePath/{ref}/SKILL.md。 */
  skillProvider?: SkillContentProvider;
  /** 控制默认 context renderer 如何展示 skill；返回 null 可隐藏正文。 */
  skillRenderer?: SkillContentRenderer;
  /** skill 缺失或 provider/renderer 出错时的策略。默认均为 ignore。 */
  skillFailure?: SkillFailurePolicies;
  /** 按 graphId/nodeId 声明 renderer。Node 覆盖 Graph。 */
  contextRenderers?: ContextRendererRegistry;
}

export interface ContextRendererRegistry {
  graphs?: Readonly<Record<string, NodeContextRenderer>>;
  nodes?: Readonly<Record<string, Readonly<Record<string, NodeContextRenderer>>>>;
}

export interface LoopGraphExecutionOptions {
  /** 本次直接 executeGraph 调用的最高优先级 renderer。
   * 沿共享 Session 的 call/compose 传播，不跨 delegate Session。 */
  contextRenderer?: NodeContextRenderer;
}

export interface CompletionToolResultInput {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  result: Readonly<Record<string, unknown>>;
}

export type CompletionToolResultFormatter =
  (input: CompletionToolResultInput) => string;

export interface LoopGraphLimits {
  /** 顶层 root 图最大节点步数。默认 100。 */
  rootMaxSteps?: number;
  /** call/compose 子图最大节点步数。默认 50。 */
  childMaxSteps?: number;
  /** 单次 NodeContext.runAgent 超时毫秒数。默认 300000（5 分钟）。 */
  agentRunTimeoutMs?: number;
}

export interface LoopGraphExtension {
  /** 注册一张图。有 invocation 的图自动注册为 pi 命令 + 工具。 */
  registerGraph(graph: Graph): void;

  /** 直接执行一张图。内部使用，公开供测试和高级场景。 */
  executeGraph(
    graph: Graph,
    trigger:
      | { source: "command"; args?: string; params?: Record<string, unknown> }
      | { source: "tool"; params?: Record<string, unknown> },
    options?: LoopGraphExecutionOptions,
  ): Promise<GraphRunResult>;
}

// ── 工厂函数 ───────────────────────────────────────────────

export function createLoopGraphExtension(
  pi: ExtensionAPI,
  options: LoopGraphExtensionOptions = {},
): LoopGraphExtension {
  const limits = resolveLoopGraphLimits(options.limits);
  const modelMessageFormatter: ModelMessageFormatter = {
    validationRetry: options.modelMessageFormatter?.validationRetry
      ?? defaultModelMessageFormatter.validationRetry,
    incompleteNode: options.modelMessageFormatter?.incompleteNode
      ?? defaultModelMessageFormatter.incompleteNode,
    deadRun: options.modelMessageFormatter?.deadRun
      ?? defaultModelMessageFormatter.deadRun,
    graphFailure: options.modelMessageFormatter?.graphFailure
      ?? defaultModelMessageFormatter.graphFailure,
  };
  // ── 实例级状态（替代原模块级 activeRuntime / activeNodeContext）──

  let activeRuntime: GraphRuntime | null = null;
  let activeNodeContext: PiNodeContext | null = null;
  /** renderer 结果按 scopeId 保存，避免嵌套 call/compose 覆盖父节点的恢复载荷。 */
  const renderedContextByScope = new Map<string, readonly MessageEntry[]>();
  let rootRunActive = false;
  const defaultTools = options.defaultTools ?? [];
  const skillBasePath = options.skillBasePath ?? path.join(process.cwd(), "skills");
  const skillProvider = options.skillProvider ?? defaultSkillContentProvider;
  const skillRenderer = options.skillRenderer ?? defaultSkillContentRenderer;
  const skillFailure = {
    missing: options.skillFailure?.missing ?? "ignore",
    error: options.skillFailure?.error ?? "ignore",
  } as const;
  // 配置在 extension 创建时快照化，避免业务在图运行期间修改 registry，
  // 造成同一节点不同 visit 使用不同 renderer。
  const graphContextRenderers = new Map(
    Object.entries(options.contextRenderers?.graphs ?? {}),
  );
  const nodeContextRenderers = new Map(
    Object.entries(options.contextRenderers?.nodes ?? {}).map(
      ([graphId, renderers]) => [graphId, new Map(Object.entries(renderers))] as const,
    ),
  );

  /** 已完成工具存在性校验的图 ID（首次 executeGraph 时校验一次） */
  const toolValidated = new Set<string>();
  let pendingCompactionFrameBase: number | null = null;

  /**
   * Session 级 compaction 边界违规标记。共享 call/compose 活跃期间异常收到
   * session_compact 时设为 true，此后本 session 投影持续过滤 compactionSummary。
   */
  let sessionCompactionBoundaryViolated = false;

  // ── 实例级图注册表（替代原全局 graphs Map）──

  const delegateInvoker: GraphInvoker = options.createDelegateHost
    ? new DelegateGraphInvoker(pi, options.createDelegateHost)
    : {
        async invoke() {
          throw new Error("图请求 delegate 隔离边界，但未配置 createDelegateHost");
        },
      };
  const registry = new GraphRegistry(pi, delegateInvoker, {
    toolResultMaxBytes: options.toolResultMaxBytes,
  });

  // ── 注册 __graph_complete__ 工具 ──

  if (!completeToolRegistered.has(pi as object)) {
    pi.registerTool(createCompleteTool());
    completeToolRegistered.add(pi as object);
  }

  // ── 注册钩子 ──

  // context 投影钩子 — 始终清洗已闭合图调用区段；仅活动图时再做节点级投影
  (pi as any).on("context", (e: any) => {
    // start/end 配对已可能被 compaction 切断，任何保留 transcript 的归属都
    // 无法证明。宁可让该 session 丧失上下文，也绝不把子图细节泄到外层。
    if (sessionCompactionBoundaryViolated) return { messages: [] };

    let messages = stripClosedGraphCalls(e.messages as any[]);

    const rt = activeRuntime;
    if (!rt?.isNodeActive) return { messages };

    // agent-choice 路由：提取可用边描述供 projection 渲染
    const nodeId = rt.currentNodeId;
    const routing = nodeId ? rt.topGraph?.routing[nodeId] : undefined;
    const availableEdges =
      routing?.router.kind === "agent-choice"
        ? routing.edges.map((ed) => ({
            id: ed.id,
            description: ed.description ?? "",
            priority: ed.priority,
            target: typeof ed.to === "symbol" ? "END" : String(ed.to),
          }))
        : undefined;

    const input = {
      messages,
      frames: rt.projectedFrames,
      currentNode: rt.currentNode,
      activeScope: rt.currentScope,
      availableEdges,
      frameFormatter: options.frameFormatter,
      compactionActive: rt.compactionGeneration > 0,
      renderedContext: rt.currentScope
        ? renderedContextByScope.get(rt.currentScope.scopeId) ?? []
        : [],
    };
    const projected = projectMessages(input);
    debugLog.projection(input, projected as any[]);
    return { messages: projected };
  });

  // pi 原生 compaction summary + firstKeptEntryId 后的 recent messages 是旧上下文
  // 的权威替代。SDK 只推进 frame 投影基线，不重发 scope，也不遮挡 summary。
  //
  // 共享 Session 的嵌套 call/compose 不能允许 compaction 跨越 GraphCallScope：
  // pi 的 summary 基于原始 session entries 生成，可能混入子图内部 transcript；
  // 混合摘要事后无法可靠拆分。
  (pi as any).on("session_before_compact", (event: any) => {
    const rt = activeRuntime;
    if (!rt?.hasActiveSharedCall) {
      if (rt?.isNodeActive) {
        pendingCompactionFrameBase = findCompactedFrameBase(
          event?.branchEntries,
          event?.preparation?.firstKeptEntryId,
          rt.completedFrameScopes,
        );
      }
      return;
    }

    debugLog.compactionBlocked(
      event?.reason,
      rt.callStack.length,
    );
    return { cancel: true };
  });

  (pi as any).on("session_compact", (event: any) => {
    const rt = activeRuntime;

    // 共享 call/compose 活跃期间如果异常收到 session_compact（cancel 策略被
    // 竞态或第三方 extension 绕过），标记为边界违规。此后本 session 投影中将
    // 持续过滤 compactionSummary，优先保证不泄漏混合摘要；不会重发 call_start。
    if (rt?.hasActiveSharedCall) {
      sessionCompactionBoundaryViolated = true;
      rt.compactionBoundaryViolated = true;
      pendingCompactionFrameBase = null;
      debugLog.graphError(
        rt.topGraph?.id ?? "?",
        `compaction 边界违规：共享 call/compose 活跃期间收到 session_compact (reason: ${JSON.stringify(event?.reason)})`,
      );
      return;
    }

    const node = rt?.currentNode;
    const scope = rt?.currentScope;
    const graph = rt?.topGraph;
    const nodeId = rt?.currentNodeId;
    if (!rt?.isNodeActive || !node || !scope || !graph || !nodeId) return;

    const generation = rt.recordCompaction(pendingCompactionFrameBase ?? undefined);
    pendingCompactionFrameBase = null;
    debugLog.scopeCheckpoint(scope.scopeId, generation, event?.reason, event?.willRetry);
  });

  // 捕获 __graph_complete__ 调用
  pi.on("tool_result", (event) => {
    if (event.toolName !== COMPLETE_TOOL_NAME || !activeNodeContext) return;
    const params = event.details as any;
    if (params?.status) {
      const nodeId = activeRuntime?.currentNodeId ?? "?";
      debugLog.agentComplete(nodeId, {
        nodeId,
        status: params.status,
        result: params.result ?? {},
      });
      activeNodeContext.recordCompletion({
        status: params.status,
        result: params.result ?? {},
      });
      if (options.completionToolResultFormatter) {
        const text = options.completionToolResultFormatter(Object.freeze({
          nodeId,
          status: params.status,
          result: snapshotRendererValue(params.result ?? {}) as Readonly<Record<string, unknown>>,
        }));
        return { content: [{ type: "text", text }] };
      }
    }
  });

  // agent 结束 → resolve Promise
  pi.on("agent_end", () => {
    activeNodeContext?.onAgentEnd();
  });

  // 新 session 必须解除 fail-closed；runtime-only session 同样需要该重置。
  pi.on("session_start", async (_event, ctx) => {
    pendingCompactionFrameBase = null;
    sessionCompactionBoundaryViolated = false;
    if (!options.runtimeOnly) {
      ctx.ui.notify("Loop Graph Extension 已加载", "info");
    }
  });

  // 注册 skill 路径（pi 原生 skill 系统扫描）
  if (!options.runtimeOnly) {
    pi.on("resources_discover", (_event) => {
      if (fs.existsSync(skillBasePath)) {
        return { skillPaths: [skillBasePath] };
      }
      return {};
    });
  }

  // ── 注册 demo 图（仅在 debug/demo 模式）──

  if (options.demoGraphs) {
    registry.registerGraph(reviewGraph);
    registry.registerGraph(probeGraph);
    registry.registerGraph(chainGraph);
    registry.registerGraph(subgraphGraph);
    registry.registerGraph(validateTestGraph);
  }

  // ── Runtime 主循环 ──────────────────────────────────────

  async function executeGraph(
    piInner: ExtensionAPI,
    graph: Graph,
    trigger: { source: string; args?: string; params?: Record<string, unknown> },
    executionOptions?: LoopGraphExecutionOptions,
  ): Promise<GraphRunResult> {
    if (rootRunActive) {
      throw new Error(
        "同一 LoopGraphExtension instance 不支持并发 root executeGraph；请为并发任务创建独立 AgentSession 或 delegate host",
      );
    }

    assertValidGraph(graph, {
      supportedBoundaries: options.createDelegateHost
        ? ["call", "compose", "delegate"]
        : ["call", "compose"],
      delegateHostAvailable: options.createDelegateHost != null,
    });

    // 首次执行：校验工具存在性（pi.getAllTools() 此时已包含所有已注册工具）
    if (!toolValidated.has(graph.id)) {
      const allTools = piInner.getAllTools();
      const registeredNames = new Set(allTools.map((t) => t.name));
      const issues = validateGraphTools(graph, defaultTools, registeredNames);
      if (issues.length > 0) {
        throw new Error(
          `图 "${graph.id}" 工具存在性校验失败:\n` +
            issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"),
        );
      }
      toolValidated.add(graph.id);
    }

    const runtime = new GraphRuntime();
    const nodeContext = new PiNodeContext(
      piInner,
      limits.agentRunTimeoutMs,
      modelMessageFormatter,
    );
    rootRunActive = true;

    // 保存/恢复外层运行时状态（支持子图嵌套时切换 activeRuntime）
    const prevRt = activeRuntime;
    const prevNc = activeNodeContext;
    activeRuntime = runtime;
    activeNodeContext = nodeContext;

    try {
      // 必须位于 rootRunActive 对应的 try/finally 内；日志 IO 失败也不能让
      // extension instance 永久停留在 busy 状态。
      debugLog.graphStart(graph.id, trigger);
      const background =
        trigger.source === "tool" || trigger.params
          ? (trigger.params ?? {})
          : { args: trigger.args ?? "" };
      const result = await runGraphLoop({
        runtime,
        nodeContext,
        graph,
        background,
        boundary: "root",
        maxSteps: limits.rootMaxSteps,
        invocationKind: trigger.source === "command" ? "command" : "tool",
        contextRenderer: executionOptions?.contextRenderer,
      });
      piInner.sendMessage({
        customType: result.status === "failed" ? "loop_graph_error" : "loop_graph_complete",
        content: result.status === "failed"
          ? `图结束（失败）：${String(result.result.reason ?? "未知原因")}`
          : `图完成（${result.steps} 步）`,
        display: true,
      });
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debugLog.graphError(graph.id, reason);

      // 向 agent 注入终止信号，让图运行层的事被 agent 感知
      piInner.sendUserMessage(
        modelMessageFormatter.graphFailure({ graphId: graph.id, reason }),
      );

      piInner.sendMessage({
        customType: "loop_graph_error",
        content: `图运行错误: ${reason}`,
        display: true,
      });
      return {
        graphId: graph.id,
        status: "failed",
        result: { reason },
        steps: runtime.topInstance?.frames.length ?? 0,
      };
    } finally {
      runtime.reset();
      nodeContext.reset();
      restoreDefaultTools(piInner);
      activeRuntime = prevRt;
      activeNodeContext = prevNc;
      renderedContextByScope.clear();
      rootRunActive = false;
    }
  }

  // ── 返回公开 API ────────────────────────────────────────

  return {
    registerGraph: (graph) => {
      if (options.runtimeOnly && graph.invocation) {
        // Graph 定义（尤其 nodes/routing 内的函数）在 SDK 中是只读的。这里只
        // 剥离顶层对外入口，刻意共享内部引用；深拷贝既无必要，也无法安全复制函数。
        registry.registerGraph({ ...graph, invocation: undefined }, defaultTools);
        return;
      }
      registry.registerGraph(graph, defaultTools);
    },
    // 公开接口只暴露 (graph, trigger)，内部 executeGraph 已有 pi
    executeGraph(graph, trigger, executionOptions) {
      return executeGraph(pi, graph, trigger, executionOptions);
    },
  };

  interface RunGraphLoopRequest {
    runtime: GraphRuntime;
    nodeContext: PiNodeContext;
    graph: Graph;
    background: Record<string, unknown>;
    boundary: "root" | "call" | "compose";
    maxSteps: number;
    sharedInstance?: AgentInstance;
    parentNodeId?: string;
    /** root 调用时由 executeGraph 传入；子调用默认为 "graph-node"。 */
    invocationKind?: import("../type.js").GraphInvocationKind;
    /** root 调用点 renderer；共享 call/compose 向下传播。 */
    contextRenderer?: NodeContextRenderer;
  }

  /**
   * 同一 Session 内 root、call 与 compose 的唯一执行循环。它只编排节点、边和 frames，
   * 不负责命令/tool UI 或 AgentSession host 生命周期。
   */
  async function runGraphLoop(request: RunGraphLoopRequest): Promise<GraphRunResult> {
    const { runtime, nodeContext, graph, background, boundary, maxSteps, sharedInstance, parentNodeId, invocationKind } = request;
    // ── GraphCallScope 调用边界消息 ──
    const callId = crypto.randomUUID();
    let callStarted = false;
    let graphPushed = false;
    let instance: AgentInstance | null = null;
    const effectiveInvocationKind = invocationKind ?? "graph-node";
    let lastResult: GraphRunResult = { graphId: graph.id, status: "failed", result: { reason: "unknown" }, steps: 0 };
    try {
      instance = runtime.pushGraph(graph, background, boundary, sharedInstance, parentNodeId);
      graphPushed = true;

      if (boundary === "call" || boundary === "compose") {
        pi.sendMessage({
          customType: "loop_graph_call_start",
          content: `[Loop Graph call started: ${graph.id}]`,
          display: false,
          details: {
            protocol: 2,
            callId,
            graphRunId: runtime.graphRunId,
            graphId: graph.id,
            boundary,
            invocationKind: effectiveInvocationKind,
            parentNodeId: parentNodeId ?? undefined,
          },
        });
        callStarted = true;
      }

      const entry = graph.entries.find((candidate) => {
        try { return candidate.guard(background); } catch { return false; }
      });
      if (!entry) {
        lastResult = {
          graphId: graph.id,
          status: "failed",
          result: { reason: `无匹配入口: ${JSON.stringify(background)}` },
          steps: 0,
        };
        if (boundary === "call") {
          throw new Error(`子图 ${graph.id} 无匹配入口`);
        }
        debugLog.graphEnd(graph.id, lastResult.steps, lastResult.status, debugLog.preview(lastResult.result, 200), instance.frames);
        return lastResult;
      }

      let nodeId = entry.startNodeId;
      let input: NodeInput = {
        data: entry.mapInput ? entry.mapInput(background) : background,
        source: { kind: "entry", entryId: entry.id },
      };

      const finish = (result: GraphRunResult): GraphRunResult => {
        debugLog.graphEnd(graph.id, result.steps, result.status, debugLog.preview(result.result, 200), instance!.frames);
        return result;
      };

      for (let step = 0; step < maxSteps; step++) {
        const node = graph.nodes[nodeId];
        if (!node) throw new Error(`节点未找到: ${nodeId}`);

        const previousTools = saveActiveTools(pi);
        try {
          setNodeToolsForInstance(pi, node);
          debugLog.toolsChanged(nodeId, pi.getActiveTools());

          const scope = runtime.nextScope(nodeId);
          const availableEdges = getAvailableEdges(graph, nodeId) ?? [];
          const skill = await loadSkillContent(graph, node, input);
          const renderer = resolveNodeContextRenderer(
            graph.id,
            node.id,
            request.contextRenderer,
          );
          const renderedContext = renderNodeContext({
            graph,
            node,
            input,
            frames: runtime.projectedFrames,
            availableEdges,
            skill,
          }, scope, renderer);
          renderedContextByScope.set(scope.scopeId, renderedContext);
          appendRenderedNodeContext(pi, renderedContext);

          runtime.enterNode(nodeId, scope, input);
          debugLog.enterNode(
            runtime.callStack.length,
            nodeId,
            scope.scopeId,
            input,
            runtime.topInstance?.frames ?? [],
          );
          nodeContext.setCurrentNodeId(nodeId);

          await applyMechanisms(pi, runtime.topInstance!, node, input, runtime.top?.localMechanisms);
          runtime.assertNoCompactionBoundaryViolation();
          const effectiveNode = wrapWithAgentChoiceValidator(graph, nodeId, node);
          nodeContext.setNodeCompletionValidator(
            effectiveNode.kind === "code" ? effectiveNode.validateCompletion : undefined,
          );
          const completion = await execNodeInGraph(
            runtime,
            nodeContext,
            effectiveNode,
            input,
            async (graphNode, callBackground) => {
              const graphBoundary = graphNode.boundary ?? "call";
              if (graphBoundary === "delegate") {
                const child = await delegateInvoker.invoke(graphNode.graph, {
                  background: callBackground,
                  invocationKind: "graph-node",
                  boundary: "delegate",
                });
                return {
                  nodeId: graphNode.id,
                  status: child.status,
                  result: child.result,
                };
              }
              if (graphBoundary === "compose") {
                const parentInstance = runtime.topInstance;
                if (!parentInstance) throw new Error("compose 调用缺少父 AgentInstance");
                const segment = runtime.beginFrameSegment(graphNode.graph.id, graphNode.id);
                debugLog.frameSegmentStart(segment.graphId, segment.parentNodeId, segment.baseIndex, segment.depth);
                try {
                  const child = await runGraphLoop({
                    runtime,
                    nodeContext,
                    graph: graphNode.graph,
                    background: callBackground,
                    boundary: "compose",
                    maxSteps: limits.childMaxSteps,
                    sharedInstance: parentInstance,
                    parentNodeId: graphNode.id,
                    contextRenderer: request.contextRenderer,
                  });
                  const frames = runtime.readFrameSegment(segment);
                  const folded = graphNode.fold
                    ? graphNode.fold({ segment: frames, finalResult: child })
                    : { status: child.status, result: child.result };
                  const completion: NodeCompletion = {
                    nodeId: graphNode.id,
                    status: folded.status,
                    result: folded.result,
                  };
                  debugLog.frameSegmentClose(segment.graphId, segment.parentNodeId, frames, completion);
                  return runtime.closeFrameSegment(segment, completion);
                } catch (error) {
                  runtime.rollbackFrameSegment(segment);
                  debugLog.frameSegmentRollback(
                    segment.graphId,
                    segment.parentNodeId,
                    error instanceof Error ? error.message : String(error),
                  );
                  throw error;
                }
              }

              const child = await runGraphLoop({
                runtime,
                nodeContext,
                graph: graphNode.graph,
                background: callBackground,
                boundary: "call",
                // 保持旧子图的独立上限，避免本次抽取改变 call 的失败语义。
                maxSteps: limits.childMaxSteps,
                parentNodeId: graphNode.id,
                contextRenderer: request.contextRenderer,
              });
              return { nodeId: graphNode.id, status: child.status, result: child.result };
            },
          );
          runtime.assertNoCompactionBoundaryViolation();

          const routing = graph.routing[nodeId];
          if (!routing) throw new Error(`节点 ${nodeId} 无路由`);
          const edge = await selectEdge(routing, completion, runtime.topInstance!);
          if (!edge) {
            const frame = {
              nodeId: completion.nodeId,
              status: completion.status,
              summary: `${nodeId} 完成(${completion.status})，无匹配边，图结束`,
              result: completion.result,
            };
            runtime.exitNode(frame);
            debugLog.exitNode(runtime.callStack.length, nodeId, completion, frame, instance.frames);
            lastResult = {
              graphId: graph.id,
              status: completion.status,
              result: completion.result,
              steps: step + 1,
            };
            return finish(lastResult);
          }

          const migration = edge.migrate(runtime.topInstance!, completion);
          runtime.exitNode(migration.frame);
          debugLog.exitNode(
            runtime.callStack.length,
            nodeId,
            completion,
            migration.frame,
            instance.frames,
          );

          if (edge.to === END) {
            lastResult = {
              graphId: graph.id,
              status: migration.output?.status ?? migration.frame.status ?? completion.status,
              result: migration.output?.result ?? migration.frame.result ?? completion.result,
              steps: step + 1,
            };
            return finish(lastResult);
          }

          nodeId = edge.to as string;
          input = {
            data: migration.input ?? {},
            source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
          };
        } finally {
          restoreActiveTools(pi, previousTools);
        }
      }

      lastResult = {
        graphId: graph.id,
        status: "failed",
        result: { reason: `Max steps (${maxSteps}) exceeded` },
        steps: maxSteps,
      };
      return finish(lastResult);
    } finally {
      try {
        if (callStarted) {
          pi.sendMessage({
            customType: "loop_graph_call_end",
            content: `[Loop Graph call completed: ${graph.id}]`,
            display: false,
            details: {
              protocol: 2,
              callId,
              graphRunId: runtime.graphRunId,
              graphId: graph.id,
              boundary,
              invocationKind: effectiveInvocationKind,
              status: lastResult.status,
            },
          });
        }
      } finally {
        if (graphPushed) runtime.popGraph();
      }
    }
  }

  function setNodeToolsForInstance(piInner: ExtensionAPI, node: Node): void {
    const nodeTools = node.kind === "code" ? (node.tools ?? []) : [];
    piInner.setActiveTools(resolveNodeTools(defaultTools, nodeTools));
  }

  /**
   * 节点声明了 skill 时，在 NodeScope 消息写入前异步解析并渲染正文；
   * 随后 appendRenderedNodeContext 保证 scope anchor → skill 的消息顺序。
   */
  async function loadSkillContent(
    graph: Graph,
    node: Node,
    input: NodeInput,
  ): Promise<{
    ref: string;
    content: string;
    message: RenderedContextMessage | null;
    showRefInCurrent: boolean;
  } | null> {
    if (node.kind !== "code" || !node.skill) return null;
    const context = createSkillLoadContext(graph, node, input, skillBasePath);
    try {
      const content = await skillProvider(node.skill, context);
      if (content == null) {
        const reason = `skill 未找到: ${node.skill}`;
        debugLog.graphError(`skill:${node.skill}`, reason);
        if (skillFailure.missing === "fail") throw new Error(reason);
        return null;
      }
      const message = skillRenderer(node.skill, content, context);
      return {
        ref: node.skill,
        content,
        message,
        showRefInCurrent: options.skillRenderer == null,
      };
    } catch (error) {
      if (skillFailure.error === "fail" ||
          (skillFailure.missing === "fail" && error instanceof Error && error.message.startsWith("skill 未找到:"))) {
        throw error;
      }
      debugLog.graphError(
        `skill:${node.skill}`,
        `加载失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  function renderNodeContext(
    input: {
      graph: Graph;
      node: Node;
      input: NodeInput;
      frames: readonly import("../type.js").ContextFrame[];
      availableEdges: readonly EdgeChoice[];
      skill: {
        ref: string;
        content: string;
        message: RenderedContextMessage | null;
        showRefInCurrent: boolean;
      } | null;
    },
    scope: import("../runtime.js").NodeScopeDescriptor,
    renderer: NodeContextRenderer,
  ): readonly MessageEntry[] {
    const renderInput: NodeContextRenderInput = Object.freeze({
      graph: createGraphContextView(input.graph),
      node: createNodeContextView(input.node),
      input: createNodeInputView(input.input),
      frames: snapshotRendererValue(input.frames) as readonly import("../type.js").ContextFrame[],
      availableEdges: Object.freeze(input.availableEdges.map((edge) => Object.freeze({ ...edge }))),
      skill: input.skill ? Object.freeze({
        ref: input.skill.ref,
        content: input.skill.content,
        message: input.skill.message ? copyRenderedMessage(input.skill.message) : null,
        showRefInCurrent: input.skill.showRefInCurrent,
      }) : null,
      completion: Object.freeze({
        toolName: COMPLETE_TOOL_NAME,
        statuses: Object.freeze(["ok", "failed", "cancelled"] as const),
      }),
      reason: "node-enter",
    });
    const rendered = renderer(renderInput);
    const anchor = rendered?.anchor ?? null;
    const additional = rendered?.additional ?? [];
    const now = Date.now();
    const frozen: MessageEntry[] = [{
      customType: NODE_SCOPE_TYPE,
      content: anchor ? copyRenderedContent(anchor.content) : "",
      details: scope,
      display: false,
      timestamp: now,
    }];
    for (let index = 0; index < additional.length; index++) {
      const message = additional[index];
      frozen.push({
        customType: renderedMessageType(message),
        content: copyRenderedContent(message.content),
        display: false,
        timestamp: now + index + 1,
      });
    }
    return Object.freeze(frozen.map((message) => Object.freeze(message)));
  }

  function resolveNodeContextRenderer(
    graphId: string,
    nodeId: string,
    callSiteRenderer: NodeContextRenderer | undefined,
  ): NodeContextRenderer {
    return callSiteRenderer
      ?? nodeContextRenderers.get(graphId)?.get(nodeId)
      ?? graphContextRenderers.get(graphId)
      ?? options.contextRenderer
      ?? defaultNodeContextRenderer;
  }

  function appendRenderedNodeContext(
    piInner: ExtensionAPI,
    messages: readonly MessageEntry[],
  ): void {
    for (const message of messages) {
      piInner.sendMessage({
        customType: message.customType!,
        content: message.content as any,
        details: message.details,
        display: false,
      });
    }
  }
}

function renderedMessageType(message: RenderedContextMessage): string {
  if (message.kind === "skill") return "loop_graph_skill";
  return `loop_graph_rendered_${message.kind ?? "instruction"}`;
}

function copyRenderedContent(
  content: RenderedContextMessage["content"],
): string | readonly RenderedContextContentBlock[] {
  if (typeof content === "string") return content;
  return Object.freeze(content.map((block) => Object.freeze({ ...block })));
}

function copyRenderedMessage(message: RenderedContextMessage): Readonly<RenderedContextMessage> {
  return Object.freeze({
    kind: message.kind,
    content: copyRenderedContent(message.content),
  });
}

function createGraphContextView(graph: Graph): import("./projection.js").GraphContextView {
  return Object.freeze({ id: graph.id, goal: graph.goal });
}

function createNodeContextView(node: Node): import("./projection.js").NodeContextView {
  return Object.freeze({
    id: node.id,
    kind: node.kind,
    subGoal: node.subGoal,
    skill: node.kind === "code" ? node.skill : undefined,
    tools: Object.freeze(node.kind === "code" ? [...(node.tools ?? [])] : []),
    boundary: node.kind === "graph" ? node.boundary : undefined,
    childGraphId: node.kind === "graph" ? node.graph.id : undefined,
  });
}

function createNodeInputView(input: NodeInput): import("./projection.js").NodeInputView {
  return Object.freeze({
    data: snapshotRendererValue(input.data) as Readonly<Record<string, unknown>>,
    source: snapshotRendererValue(input.source) as Readonly<NodeInput["source"]>,
  });
}

function createSkillLoadContext(
  graph: Graph,
  node: Node,
  input: NodeInput,
  basePath: string,
): SkillLoadContext {
  return Object.freeze({
    graph: createGraphContextView(graph),
    node: createNodeContextView(node),
    input: createNodeInputView(input),
    basePath,
  });
}

/** 创建只供 renderer 阅读的无别名快照。函数和 Symbol 不属于模型上下文数据，
 * 转为稳定文本；普通对象/数组保留循环引用，但不保留可变原型。 */
function snapshotRendererValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(snapshotRendererValue(item, seen));
    return Object.freeze(clone);
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = snapshotRendererValue(item, seen);
  }
  return Object.freeze(clone);
}

interface ResolvedLoopGraphLimits {
  rootMaxSteps: number;
  childMaxSteps: number;
  agentRunTimeoutMs: number;
}

function resolveLoopGraphLimits(limits: LoopGraphLimits | undefined): ResolvedLoopGraphLimits {
  const resolved: ResolvedLoopGraphLimits = {
    rootMaxSteps: limits?.rootMaxSteps ?? 100,
    childMaxSteps: limits?.childMaxSteps ?? 50,
    agentRunTimeoutMs: limits?.agentRunTimeoutMs ?? 5 * 60 * 1000,
  };

  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new Error(`LoopGraph limits.${name} 必须是有限正整数，收到: ${String(value)}`);
    }
  }
  return resolved;
}

// ── 内部辅助函数 ────────────────────────────────────────────
//  （封装在模块作用域，由工厂函数内调用，不暴露给外部）

/**
 * 为 agent-choice 路由合成 validateCompletion 校验器。
 *
 * 当路由策略为 agent-choice 且 node 为 code 节点时，此函数产出一个
 * 合成 validateCompletion：先运行节点自身的校验（如有），再检查
 * completion.result[agentChoiceField] 是否声明了有效的边 ID。
 *
 * 不通过时 reason 中列出所有可选边及其描述，由 PiNodeContext 的
 * 驳回→重试机制将消息注入 agent 工作流。
 */
function createAgentChoiceValidator(
  edges: Edge[],
  agentChoiceField: string | undefined,
  existingValidator?: (
    result: Record<string, unknown>,
  ) => { isValid: true } | { isValid: false; reason: string },
): (result: Record<string, unknown>) => { isValid: true } | { isValid: false; reason: string } {
  const field = agentChoiceField ?? "chosen_edge_id";

  return (result: Record<string, unknown>) => {
    // 先跑原始校验
    if (existingValidator) {
      const vr = existingValidator(result);
      if (!vr.isValid) return vr;
    }

    const chosenId = result[field];

    // 未声明
    if (typeof chosenId !== "string" || chosenId.trim().length === 0) {
      const edgeList = edges
        .map(
          (e) =>
            `  • ${e.id} (priority: ${e.priority})${e.to === END ? " → END" : ` → ${String(e.to)}`}\n    ${e.description || "(无描述)"}`,
        )
        .join("\n");
      return {
        isValid: false,
        reason: `当前节点使用 agent-choice 路由，请通过 result.${field} 声明选择哪条边。可选边:\n${edgeList}`,
      };
    }

    // 边不存在
    const found = edges.find((e) => e.id === chosenId);
    if (!found) {
      const edgeList = edges
        .map(
          (e) =>
            `  • ${e.id} (priority: ${e.priority})${e.to === END ? " → END" : ` → ${String(e.to)}`}\n    ${e.description || "(无描述)"}`,
        )
        .join("\n");
      return {
        isValid: false,
        reason: `边 "${chosenId}" 不存在。可选边:\n${edgeList}`,
      };
    }

    return { isValid: true };
  };
}

export function findCompactedFrameBase(
  branchEntries: any[] | undefined,
  firstKeptEntryId: string | undefined,
  frameScopes: readonly import("../runtime.js").NodeScopeDescriptor[],
): number {
  // 边界元数据缺失时不能声称已有 frame 已被 summary 覆盖；保持旧基线。
  if (!Array.isArray(branchEntries) || !firstKeptEntryId) return 0;
  const cut = branchEntries.findIndex((entry) => entry?.id === firstKeptEntryId);
  if (cut < 0) return 0;

  const scopePositions = new Map<string, number>();
  for (let index = 0; index < branchEntries.length; index++) {
    const entry = branchEntries[index];
    if (entry?.type !== "custom_message" || entry?.customType !== NODE_SCOPE_TYPE) continue;
    const scopeId = entry?.details?.scopeId;
    if (typeof scopeId === "string") scopePositions.set(scopeId, index);
  }

  let compacted = 0;
  for (let frameIndex = 0; frameIndex < frameScopes.length; frameIndex++) {
    const currentPos = scopePositions.get(frameScopes[frameIndex].scopeId);
    if (currentPos == null) continue;
    let nextScopePos = Number.POSITIVE_INFINITY;
    for (const pos of scopePositions.values()) {
      if (pos > currentPos && pos < nextScopePos) nextScopePos = pos;
    }
    if (nextScopePos <= cut) compacted = frameIndex + 1;
  }
  return compacted;
}

/**
 * 如果节点使用 agent-choice 路由，返回一个包装后的节点，
 * 其 validateCompletion 被替换为 agent-choice 边选择校验器。
 * 否则返回原节点。
 */
function wrapWithAgentChoiceValidator(
  graph: Graph,
  nodeId: string,
  node: Node,
): Node {
  if (node.kind !== "code") return node;

  const routing = graph.routing[nodeId];
  if (!routing || routing.router.kind !== "agent-choice") return node;

  return {
    ...node,
    validateCompletion: createAgentChoiceValidator(
      routing.edges,
      routing.agentChoiceField,
      node.validateCompletion,
    ),
  };
}

function getAvailableEdges(graph: Graph, nodeId: string): EdgeChoice[] | undefined {
  const routing = graph.routing[nodeId];
  if (routing?.router.kind !== "agent-choice") return undefined;
  return routing.edges.map((edge) => ({
    id: edge.id,
    description: edge.description ?? "",
    priority: edge.priority,
    target: typeof edge.to === "symbol" ? "END" : String(edge.to),
  }));
}

/**
 * 节点进入后、execute 之前分派横切机制。
 *
 * 顺序：全局机制（instance.mechanisms）→ 局部机制（node.mechanisms）。
 * 每个 mechanism 若有 onNodeEnter，则 await 调用，串行保证数据预处理
 * 先于 execute 完成。抛错统一记日志后继续，不中止节点。
 *
 * 必须在 NodeScope 之后调用：appendContext 追加的内容才会落在本节点 active 段，
 * 离开节点后随 ReAct 折叠，不泄漏到下一节点。
 */
async function applyMechanisms(
  pi: ExtensionAPI,
  instance: AgentInstance,
  node: Node,
  input: NodeInput,
  localMechanisms: readonly Mechanism[] = [],
): Promise<void> {
  const mechanisms: Mechanism[] = [
    ...instance.mechanisms,
    ...localMechanisms,
    ...(node.kind === "code" ? (node.mechanisms ?? []) : []),
  ];
  if (mechanisms.length === 0) return;

  const appendContext = (content: string): void => {
    pi.sendMessage({
      customType: "loop_graph_mechanism",
      content,
      display: false,
    });
  };

  const ctx: MechanismContext = { pi, instance, node, input, appendContext };
  for (const m of mechanisms) {
    if (!m.onNodeEnter) continue;
    try {
      await m.onNodeEnter(ctx);
    } catch (err) {
      debugLog.graphError(
        `mechanism:${m.name}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function execNodeInGraph(
  runtime: GraphRuntime,
  nodeContext: PiNodeContext,
  node: Node,
  input: NodeInput,
  runSubgraph: (
    graphNode: Extract<Node, { kind: "graph" }>,
    background: Record<string, unknown>,
  ) => Promise<NodeCompletion>,
): Promise<NodeCompletion> {
  if (node.kind === "graph") {
    debugLog.subgraphPush(node.id, node.graph.id);
    const result = await runSubgraph(node, input.data);
    debugLog.subgraphPop(node.id, node.graph.id, result);
    return result;
  }

  return node.execute(runtime.topInstance!, input, nodeContext);
}

// ── 工具管理 ────────────────────────────────────────────────

function saveActiveTools(pi: ExtensionAPI): string[] {
  try { return (pi as any).getActiveTools?.() ?? ["read"]; } catch { return ["read"]; }
}

function restoreActiveTools(pi: ExtensionAPI, tools: string[]): void {
  pi.setActiveTools(tools);
}

function restoreDefaultTools(pi: ExtensionAPI): void {
  pi.setActiveTools(["read"]);
}
