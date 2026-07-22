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
import { END } from "../../src/type.ts";
import { GraphRuntime } from "../../src/runtime.ts";
import { GraphRuntime as CoreGraphRuntime, } from "../../src/runtime/graph-runtime.ts";
import { GraphCatalog } from "../../src/host/graph-catalog.ts";
import { assertValidGraph, validateGraphTools } from "../../src/validate.ts";
import { selectEdge } from "../../src/router.ts";
import { defaultNodeContextRenderer, projectMessages, stripClosedGraphCalls, } from "../../src/adapter/projection.ts";
import { PiNodeContext } from "../../src/adapter/pi-node-context.ts";
import { COMPLETE_TOOL_NAME, createCompleteTool } from "../../src/adapter/complete-tool.ts";
import { resolveNodeTools } from "../../src/tools-resolve.ts";
import { debugLog } from "../../src/adapter/debug-log.ts";
import { defaultModelMessageFormatter, } from "../../src/adapter/model-messages.ts";
import { GraphRegistry } from "../../src/registry.ts";
import { DelegateGraphInvoker, } from "../../src/adapter/graph-execution-host.ts";
import { reviewGraph } from "../../src/graphs/review-graph.ts";
import { probeGraph } from "../../src/graphs/probe-graph.ts";
import { chainGraph } from "../../src/graphs/chain-graph.ts";
import { childGraph, subgraphGraph } from "../../src/graphs/subgraph-graph.ts";
import { validateGraph as validateTestGraph } from "../../src/graphs/validate-graph.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultSkillContentProvider, defaultSkillContentRenderer, } from "../../src/adapter/skill-content.ts";
import { MechanismEventBroker, MechanismInvocationGroup, MechanismStateStore, } from "../../src/adapter/mechanism-runtime.ts";
import { createJsonlTraceSink, emitLifecycleEvent, } from "../../src/adapter/observability.ts";
const NODE_SCOPE_TYPE = "loop_graph_node_scope";
const completeToolRegistered = new WeakSet();
export const defaultCompletionFeedbackFormatter = ({ decision }) => {
    if (decision.decision === "accepted") {
        if (decision.validation === "passed")
            return "节点结果已通过检查并接受。";
        return decision.completionStatus === "failed"
            ? "Agent 报告当前节点失败。"
            : "Agent 报告当前节点取消。";
    }
    if (decision.decision === "rejected") {
        return `节点结果未被接受：${decision.reason}`;
    }
    return `${decision.scope === "graph" ? "图" : "节点"}验收失败：${decision.reason}`;
};
// ── 工厂函数 ───────────────────────────────────────────────
export function createLoopGraphExtension(pi, options = {}) {
    const legacyOptions = options;
    const limits = resolveLoopGraphLimits(options.limits);
    const traceSink = options.traceSink ?? (options.debug ? createJsonlTraceSink(options.debugLogPath) : undefined);
    const emit = (event) => emitLifecycleEvent(event, traceSink, options.logger);
    const modelMessageFormatter = {
        incompleteNode: options.modelMessageFormatter?.incompleteNode
            ?? defaultModelMessageFormatter.incompleteNode,
        deadRun: options.modelMessageFormatter?.deadRun
            ?? defaultModelMessageFormatter.deadRun,
        graphFailure: options.modelMessageFormatter?.graphFailure
            ?? defaultModelMessageFormatter.graphFailure,
    };
    // ── 实例级状态（替代原模块级 activeRuntime / activeNodeContext）──
    let activeRuntime = null;
    let activeNodeContext = null;
    /** renderer 结果按 scopeId 保存，避免嵌套 call/compose 覆盖父节点的恢复载荷。 */
    const renderedContextByScope = new Map();
    let rootRunActive = false;
    const defaultTools = legacyOptions.defaultTools ?? [];
    const skillBasePath = options.skillBasePath ?? path.join(process.cwd(), "skills");
    const skillProvider = options.skillProvider ?? defaultSkillContentProvider;
    const skillRenderer = options.skillRenderer ?? defaultSkillContentRenderer;
    const skillFailure = {
        missing: options.skillFailure?.missing ?? "ignore",
        error: options.skillFailure?.error ?? "ignore",
    };
    // 配置在 extension 创建时快照化，避免业务在图运行期间修改 registry，
    // 造成同一节点不同 visit 使用不同 renderer。
    const graphContextRenderers = new Map(Object.entries(options.contextRenderers?.graphs ?? {}));
    const nodeContextRenderers = new Map(Object.entries(options.contextRenderers?.nodes ?? {}).map(([graphId, renderers]) => [graphId, new Map(Object.entries(renderers))]));
    /** 已完成工具存在性校验的图 ID（首次 executeGraph 时校验一次） */
    const toolValidated = new Set();
    const coreGraphs = new GraphCatalog();
    let pendingCompactionFrameBase = null;
    /**
     * Session 级 compaction 边界违规标记。共享 call/compose 活跃期间异常收到
     * session_compact 时设为 true，此后本 session 投影持续过滤 compactionSummary。
     */
    let sessionCompactionBoundaryViolated = false;
    // ── 实例级图注册表（替代原全局 graphs Map）──
    const delegateInvoker = options.createDelegateHost
        ? new DelegateGraphInvoker(pi, options.createDelegateHost)
        : {
            async invoke() {
                throw new Error("图请求 delegate 隔离边界，但未配置 createDelegateHost");
            },
        };
    const registry = new GraphRegistry(pi, delegateInvoker, {
        toolResultMaxBytes: options.toolResultMaxBytes,
        formatToolResult: options.formatToolResult,
        toolResolver: options.toolResolver,
    });
    // ── 注册 __graph_complete__ 工具 ──
    if (!completeToolRegistered.has(pi)) {
        pi.registerTool(createCompleteTool());
        completeToolRegistered.add(pi);
    }
    // ── 注册钩子 ──
    // context 投影钩子 — 始终清洗已闭合图调用区段；仅活动图时再做节点级投影



    pi.on("context", (e) => {
        // start/end 配对已可能被 compaction 切断，任何保留 transcript 的归属都
        // 无法证明。宁可让该 session 丧失上下文，也绝不把子图细节泄到外层。
        if (sessionCompactionBoundaryViolated)
            return { messages: [] };
        let messages = stripClosedGraphCalls(e.messages);
        const rt = activeRuntime;
        if (!rt?.isNodeActive)
            return { messages };
        // agent-choice 路由：提取可用边描述供 projection 渲染
        const nodeId = rt.currentNodeId;
        const routing = nodeId ? rt.topGraph?.routing[nodeId] : undefined;
        const availableEdges = routing?.router.kind === "agent-choice"
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
        const contract = activeNodeContext?.getActiveOutputContractMessage();
        if (contract && !projected.some((message) => message.customType === contract.customType &&
            message.details?.agentRunId === contract.details?.agentRunId)) {
            projected.push(contract);
        }
        debugLog.projection(input, projected);
        return { messages: projected };
    });
    // pi 原生 compaction summary + firstKeptEntryId 后的 recent messages 是旧上下文
    // 的权威替代。SDK 只推进 frame 投影基线，不重发 scope，也不遮挡 summary。
    //
    // 共享 Session 的嵌套 call/compose 不能允许 compaction 跨越 GraphCallScope：
    // pi 的 summary 基于原始 session entries 生成，可能混入子图内部 transcript；
    // 混合摘要事后无法可靠拆分。
    pi.on("session_before_compact", (event) => {
        const rt = activeRuntime;
        if (!rt?.hasActiveSharedCall) {
            if (rt?.isNodeActive) {
                pendingCompactionFrameBase = findCompactedFrameBase(event?.branchEntries, event?.preparation?.firstKeptEntryId, rt.completedFrameScopes);
            }
            return;
        }
        debugLog.compactionBlocked(event?.reason, rt.callStack.length);
        return { cancel: true };
    });
    pi.on("session_compact", (event) => {
        const rt = activeRuntime;
        // 共享 call/compose 活跃期间如果异常收到 session_compact（cancel 策略被
        // 竞态或第三方 extension 绕过），标记为边界违规。此后本 session 投影中将
        // 持续过滤 compactionSummary，优先保证不泄漏混合摘要；不会重发 call_start。
        if (rt?.hasActiveSharedCall) {
            sessionCompactionBoundaryViolated = true;
            rt.compactionBoundaryViolated = true;
            pendingCompactionFrameBase = null;
            debugLog.graphError(rt.topGraph?.id ?? "?", `compaction 边界违规：共享 call/compose 活跃期间收到 session_compact (reason: ${JSON.stringify(event?.reason)})`);
            return;
        }
        const node = rt?.currentNode;
        const scope = rt?.currentScope;
        const graph = rt?.topGraph;
        const nodeId = rt?.currentNodeId;
        if (!rt?.isNodeActive || !node || !scope || !graph || !nodeId)
            return;
        const generation = rt.recordCompaction(pendingCompactionFrameBase ?? undefined);
        pendingCompactionFrameBase = null;
        debugLog.scopeCheckpoint(scope.scopeId, generation, event?.reason, event?.willRetry);
        emit(Object.freeze({
            type: "compaction",
            timestamp: Date.now(),
            graphId: graph.id,
            nodeId,
            scopeId: scope.scopeId,
            generation,
            reason: snapshotRendererValue(event?.reason),
        }));
    });
    // 捕获 __graph_complete__ 调用
    pi.on("tool_result", async (event) => {
        if (event.toolName !== COMPLETE_TOOL_NAME || !activeNodeContext)
            return;
        const params = event.input;
        const nodeId = activeRuntime?.currentNodeId ?? "?";
        if (!params ||
            !["ok", "failed", "cancelled"].includes(params.status) ||
            !params.result ||
            typeof params.result !== "object" ||
            Array.isArray(params.result)) {
            const decision = {
                decision: "rejected",
                reason: "完成提交必须包含合法的 status 和对象类型 result",
            };
            const text = (options.completionFeedbackFormatter ?? defaultCompletionFeedbackFormatter)(Object.freeze({ nodeId, decision }));
            return { content: [{ type: "text", text }], details: decision, isError: true };
        }
        debugLog.agentComplete(nodeId, {
            nodeId,
            status: params.status,
            result: params.result,
        });
        const decision = await activeNodeContext.submitCompletion({
            status: params.status,
            result: params.result,
        });
        const text = (options.completionFeedbackFormatter ?? defaultCompletionFeedbackFormatter)(Object.freeze({ nodeId, decision }));
        return {

            content: [{ type: "text", text }],

            details: decision,

            isError: decision.decision !== "accepted",
        };
    });
    // agent 结束 → resolve Promise
    pi.on("agent_end", async () => {
        await activeNodeContext?.onAgentEnd();
    });
    const mechanismEventBroker = new MechanismEventBroker(pi, (failure) => {
        debugLog.graphError(`mechanism:${failure.mechanismName}:${failure.phase}`, `${failure.reason} (policy=${failure.policy})`);
    }, {
        ...options.mechanismRuntime,
        completionValidationTimeoutMs: options.mechanismRuntime?.completionValidationTimeoutMs
            ?? limits.completionValidationTimeoutMs,
    });
    const mechanismStateStore = new MechanismStateStore();
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
        for (const graph of [reviewGraph, probeGraph, chainGraph, childGraph, subgraphGraph, validateTestGraph]) {
            coreGraphs.register(graph);
        }
    }
    // ── Runtime 主循环 ──────────────────────────────────────
    async function executeGraph(piInner, graph, trigger, executionOptions) {
        if (rootRunActive) {
            throw new Error("同一 LoopGraphExtension instance 不支持并发 root executeGraph；请为并发任务创建独立 AgentSession 或 delegate host");
        }
        if (isCoreGraph(graph)) {
            rootRunActive = true;
            try {
                const background = trigger.source === "tool" || trigger.params
                    ? (trigger.params ?? {})
                    : { args: trigger.args ?? "" };
                const runtime = new CoreGraphRuntime({
                    catalog: coreGraphs,
                    toolCatalog: options.toolCatalog,
                    skillCatalog: options.skillCatalog,
                    unsafeToolResolver: options.unsafeToolResolver,
                    baseline: options.baseline,
                });
                const result = await runtime.execute(graph, background, limits.rootMaxSteps);
                return result;
            }
            finally {
                rootRunActive = false;
            }
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
            const issues = validateGraphTools(graph, defaultTools, registeredNames, (nodeId, nodeTools) => resolveNodeTools(defaultTools, nodeTools, options.toolResolver, { graphId: graph.id, nodeId }));
            if (issues.length > 0) {
                throw new Error(`图 "${graph.id}" 工具存在性校验失败:\n` +
                    issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"));
            }
            toolValidated.add(graph.id);
        }
        const runtime = new GraphRuntime();
        const nodeContext = new PiNodeContext(piInner, limits.agentRunTimeoutMs, modelMessageFormatter, limits.completionValidationTimeoutMs, options.outputContractMaxBytes, (agentRunEvent) => {
            const scope = runtime.currentScope;
            const activeGraph = runtime.topGraph;
            const nodeId = runtime.currentNodeId;
            if (!scope || !activeGraph || !nodeId)
                return;
            emit(Object.freeze({
                ...agentRunEvent,
                timestamp: Date.now(),
                graphRunId: runtime.graphRunId,
                graphId: activeGraph.id,
                nodeId,
                scopeId: scope.scopeId,
            }));
        });
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
            const background = trigger.source === "tool" || trigger.params
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
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            debugLog.graphError(graph.id, reason);
            // 向 agent 注入终止信号，让图运行层的事被 agent 感知
            piInner.sendUserMessage(modelMessageFormatter.graphFailure({ graphId: graph.id, reason }));
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
        }
        finally {
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
    const registerGraphInternal = (graph) => {
        if (isCoreGraph(graph)) {
            coreGraphs.register(graph);
            return;
        }
        if (options.runtimeOnly && graph.invocation) {
            registry.registerGraph({ ...graph, invocation: undefined }, defaultTools);
            return;
        }
        registry.registerGraph(graph, defaultTools);
    };
    return {
        registerGraph: registerGraphInternal,
        // 公开接口只暴露 (graph, trigger)，内部 executeGraph 已有 pi
        executeGraph: ((graph, trigger, executionOptions) => executeGraph(pi, graph, trigger, executionOptions)),
    };
    /**
     * 同一 Session 内 root、call 与 compose 的唯一执行循环。它只编排节点、边和 frames，
     * 不负责命令/tool UI 或 AgentSession host 生命周期。
     */
    async function runGraphLoop(request) {
        const { runtime, nodeContext, graph, background, boundary, maxSteps, sharedInstance, parentNodeId, invocationKind } = request;
        // ── GraphCallScope 调用边界消息 ──
        const callId = crypto.randomUUID();
        let callStarted = false;
        let graphPushed = false;
        let instance = null;
        const effectiveInvocationKind = invocationKind ?? "graph-node";
        let lastResult = { graphId: graph.id, status: "failed", result: { reason: "unknown" }, steps: 0 };
        try {
            instance = runtime.pushGraph(graph, background, boundary, sharedInstance, parentNodeId);
            graphPushed = true;
            emit(Object.freeze({
                type: "graph_start",
                timestamp: Date.now(),
                graphId: graph.id,
                boundary,
                invocationKind: effectiveInvocationKind,
            }));
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
            const finish = (result) => {
                debugLog.graphEnd(graph.id, result.steps, result.status, debugLog.preview(result.result, 200), instance.frames);
                emit(Object.freeze({
                    type: "graph_end",
                    timestamp: Date.now(),
                    graphId: graph.id,
                    status: result.status,
                    steps: result.steps,
                }));
                return result;
            };
            const entry = graph.entries.find((candidate) => {
                try {
                    return candidate.guard(background);
                }
                catch {
                    return false;
                }
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
                return finish(lastResult);
            }
            let nodeId = entry.startNodeId;
            let input = {
                data: entry.mapInput ? entry.mapInput(background) : background,
                source: { kind: "entry", entryId: entry.id },
            };
            for (let step = 0; step < maxSteps; step++) {
                const node = graph.nodes[nodeId];
                if (!node)
                    throw new Error(`节点未找到: ${nodeId}`);
                const previousTools = saveActiveTools(pi);
                let mechanismInvocations = null;
                let activeMechanisms = [];
                let mechanismScopeId = null;
                try {
                    setNodeToolsForInstance(pi, node);
                    debugLog.toolsChanged(nodeId, pi.getActiveTools());
                    const scope = runtime.nextScope(nodeId);
                    mechanismScopeId = scope.scopeId;
                    const availableEdges = getAvailableEdges(graph, nodeId) ?? [];
                    const skill = await loadSkillContent(graph, node, input);
                    const renderer = resolveNodeContextRenderer(graph.id, node.id, request.contextRenderer);
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
                    debugLog.enterNode(runtime.callStack.length, nodeId, scope.scopeId, input, runtime.topInstance?.frames ?? []);
                    emit(Object.freeze({
                        type: "node_enter",
                        timestamp: Date.now(),
                        graphId: graph.id,
                        nodeId,
                        scopeId: scope.scopeId,
                        depth: runtime.callStack.length,
                    }));
                    nodeContext.setCurrentNodeId(nodeId);
                    mechanismInvocations = new MechanismInvocationGroup(scope, () => runtime.isNodeActive && runtime.currentScope?.scopeId === scope.scopeId);
                    activeMechanisms = prepareMechanismInvocations(pi, runtime.topInstance, node, input, runtime.top?.localMechanisms, mechanismInvocations, mechanismEventBroker, mechanismStateStore);
                    nodeContext.setMechanismLifecycle({
                        beforeAgentRun: (agentRunId, request) => mechanismEventBroker.beginAgentRun(agentRunId, request, activeMechanisms),
                        validateCompletion: (agentRunId, completion) => mechanismEventBroker.validateCompletion(agentRunId, completion),
                        afterAgentRun: (agentRunId) => mechanismEventBroker.endAgentRun(agentRunId),
                    });
                    const enterFailures = await invokeMechanismEnterHooks(activeMechanisms);
                    const earlyEventFailures = mechanismEventBroker.consumeControlFailures(scope.scopeId);
                    const preExecFailures = [...enterFailures, ...earlyEventFailures];
                    const enterControl = resolveMechanismControlFailure(preExecFailures);
                    if (enterControl?.policy === "fail-graph") {
                        throw createMechanismControlError(enterControl, preExecFailures);
                    }
                    runtime.assertNoCompactionBoundaryViolation();
                    const effectiveNode = wrapWithAgentChoiceValidator(graph, nodeId, node);
                    nodeContext.setNodeCompletionValidator(node.kind === "code" ? node.validateCompletion : undefined);
                    nodeContext.setPostMechanismCompletionValidator(getAgentChoiceValidator(graph, nodeId, node));
                    let completion = enterControl?.policy === "fail-node"
                        ? createMechanismFailedCompletion(nodeId, enterControl, preExecFailures)
                        : await execNodeInGraph(runtime, nodeContext, effectiveNode, input, async (graphNode, callBackground) => {
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
                                if (!parentInstance)
                                    throw new Error("compose 调用缺少父 AgentInstance");
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
                                    const completion = {
                                        nodeId: graphNode.id,
                                        status: folded.status,
                                        result: folded.result,
                                    };
                                    debugLog.frameSegmentClose(segment.graphId, segment.parentNodeId, frames, completion);
                                    return runtime.closeFrameSegment(segment, completion);
                                }
                                catch (error) {
                                    runtime.rollbackFrameSegment(segment);
                                    debugLog.frameSegmentRollback(segment.graphId, segment.parentNodeId, error instanceof Error ? error.message : String(error));

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
                        });
                    const eventFailures = mechanismEventBroker.consumeControlFailures(scope.scopeId);
                    const preExitFailures = [...preExecFailures, ...eventFailures];
                    const eventControl = resolveMechanismControlFailure(preExitFailures);
                    if (eventControl?.policy === "fail-graph") {
                        throw createMechanismControlError(eventControl, preExitFailures);
                    }
                    if (eventControl?.policy === "fail-node") {
                        completion = createMechanismFailedCompletion(nodeId, eventControl, preExitFailures);
                    }
                    const exitFailures = await invokeMechanismExitHooks(activeMechanisms, completion);
                    const lateEventFailures = mechanismEventBroker.consumeControlFailures(scope.scopeId);
                    const allControlFailures = [
                        ...preExitFailures,
                        ...exitFailures,
                        ...lateEventFailures,
                    ];
                    const exitControl = resolveMechanismControlFailure(allControlFailures);
                    if (exitControl?.policy === "fail-graph") {
                        throw createMechanismControlError(exitControl, allControlFailures);
                    }
                    if (exitControl?.policy === "fail-node") {
                        completion = createMechanismFailedCompletion(nodeId, exitControl, allControlFailures);
                    }
                    runtime.assertNoCompactionBoundaryViolation();
                    const routing = graph.routing[nodeId];
                    if (!routing)
                        throw new Error(`节点 ${nodeId} 无路由`);
                    const edge = await selectEdge(routing, completion, runtime.topInstance);
                    if (!edge) {
                        const frame = {
                            nodeId: completion.nodeId,
                            status: completion.status,
                            summary: `${nodeId} 完成(${completion.status})，无匹配边，图结束`,
                            result: completion.result,
                        };
                        runtime.exitNode(frame);
                        debugLog.exitNode(runtime.callStack.length, nodeId, completion, frame, instance.frames);
                        emit(Object.freeze({
                            type: "node_exit",
                            timestamp: Date.now(),
                            graphId: graph.id,
                            nodeId,
                            scopeId: scope.scopeId,
                            status: completion.status,
                            depth: runtime.callStack.length,
                        }));
                        lastResult = {
                            graphId: graph.id,
                            status: completion.status,
                            result: completion.result,
                            steps: step + 1,
                        };
                        return finish(lastResult);
                    }
                    const migration = edge.migrate(runtime.topInstance, completion);
                    runtime.exitNode(migration.frame);
                    debugLog.exitNode(runtime.callStack.length, nodeId, completion, migration.frame, instance.frames);
                    emit(Object.freeze({
                        type: "node_exit",
                        timestamp: Date.now(),
                        graphId: graph.id,
                        nodeId,
                        scopeId: scope.scopeId,
                        status: completion.status,
                        depth: runtime.callStack.length,
                    }));
                    if (edge.to === END) {
                        lastResult = {
                            graphId: graph.id,
                            status: migration.output?.status ?? migration.frame.status ?? completion.status,
                            result: migration.output?.result ?? migration.frame.result ?? completion.result,
                            steps: step + 1,
                        };
                        return finish(lastResult);
                    }
                    nodeId = edge.to;
                    input = {
                        data: migration.input ?? {},
                        source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
                    };
                }
                catch (error) {
                    await invokeMechanismErrorHooks(activeMechanisms, error);
                    throw error;
                }
                finally {
                    nodeContext.setMechanismLifecycle(null);
                    if (mechanismScopeId) {
                        mechanismEventBroker.consumeControlFailures(mechanismScopeId);
                    }
                    if (mechanismInvocations) {
                        const cleanupErrors = await mechanismInvocations.close();
                        for (const cleanupError of cleanupErrors) {
                            debugLog.graphError(`mechanism:${cleanupError.mechanismName}:cleanup`, cleanupError.error instanceof Error
                                ? cleanupError.error.message
                                : String(cleanupError.error));
                        }
                    }
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
        }
        catch (error) {
            emit(Object.freeze({
                type: "graph_error",

                timestamp: Date.now(),
                graphId: graph.id,
                error: error instanceof Error ? error.message : String(error),
            }));
            throw error;
        }
        finally {
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
            }
            finally {
                if (graphPushed)
                    runtime.popGraph();
            }
        }
    }
    function setNodeToolsForInstance(piInner, node) {
        const nodeTools = node.kind === "code" ? (node.tools ?? []) : [];
        piInner.setActiveTools(resolveNodeTools(defaultTools, nodeTools, options.toolResolver, { graphId: activeRuntime?.topGraph?.id, nodeId: node.id }));
    }
    /**
     * 节点声明了 skill 时，在 NodeScope 消息写入前异步解析并渲染正文；
     * 随后 appendRenderedNodeContext 保证 scope anchor → skill 的消息顺序。
     */
    async function loadSkillContent(graph, node, input) {
        if (node.kind !== "code" || !node.skill)
            return null;
        const context = createSkillLoadContext(graph, node, input, skillBasePath);
        try {
            const content = await skillProvider(node.skill, context);
            if (content == null) {
                const reason = `skill 未找到: ${node.skill}`;
                debugLog.graphError(`skill:${node.skill}`, reason);
                if (skillFailure.missing === "fail")
                    throw new Error(reason);
                return null;
            }
            const message = skillRenderer(node.skill, content, context);
            return {
                ref: node.skill,
                content,
                message,
                showRefInCurrent: options.skillRenderer == null,
            };
        }
        catch (error) {
            if (skillFailure.error === "fail" ||
                (skillFailure.missing === "fail" && error instanceof Error && error.message.startsWith("skill 未找到:"))) {
                throw error;
            }
            debugLog.graphError(`skill:${node.skill}`, `加载失败: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    function renderNodeContext(input, scope, renderer) {
        const renderInput = Object.freeze({
            graph: createGraphContextView(input.graph),
            node: createNodeContextView(input.node),
            input: createNodeInputView(input.input),
            frames: snapshotRendererValue(input.frames),
            availableEdges: Object.freeze(input.availableEdges.map((edge) => Object.freeze({ ...edge }))),
            skill: input.skill ? Object.freeze({
                ref: input.skill.ref,
                content: input.skill.content,
                message: input.skill.message ? copyRenderedMessage(input.skill.message) : null,
                showRefInCurrent: input.skill.showRefInCurrent,
            }) : null,
            completion: Object.freeze({
                toolName: COMPLETE_TOOL_NAME,
                statuses: Object.freeze(["ok", "failed", "cancelled"]),
            }),
            reason: "node-enter",
        });
        const rendered = renderer(renderInput);
        const anchor = rendered?.anchor ?? null;
        const additional = rendered?.additional ?? [];
        const now = Date.now();
        const frozen = [{
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
    function resolveNodeContextRenderer(graphId, nodeId, callSiteRenderer) {
        return callSiteRenderer
            ?? nodeContextRenderers.get(graphId)?.get(nodeId)
            ?? graphContextRenderers.get(graphId)

            ?? options.contextRenderer
            ?? defaultNodeContextRenderer;
    }
    function appendRenderedNodeContext(piInner, messages) {
        for (const message of messages) {
            piInner.sendMessage({

                customType: message.customType,
                content: message.content,
                details: message.details,
                display: false,
            });
        }
    }
}
function isCoreGraph(graph) {
    return "stages" in graph && "version" in graph && "input" in graph && "output" in graph;
}
function renderedMessageType(message) {
    if (message.kind === "skill")
        return "loop_graph_skill";
    return `loop_graph_rendered_${message.kind ?? "instruction"}`;
}
function copyRenderedContent(content) {
    if (typeof content === "string")
        return content;
    return Object.freeze(content.map((block) => Object.freeze({ ...block })));
}
function copyRenderedMessage(message) {
    return Object.freeze({
        kind: message.kind,
        content: copyRenderedContent(message.content),
    });
}
function createGraphContextView(graph) {
    return Object.freeze({ id: graph.id, goal: graph.goal });
}
function createNodeContextView(node) {
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
function createNodeInputView(input) {
    return Object.freeze({
        data: snapshotRendererValue(input.data),
        source: snapshotRendererValue(input.source),
    });
}
function createSkillLoadContext(graph, node, input, basePath) {
    return Object.freeze({
        graph: createGraphContextView(graph),
        node: createNodeContextView(node),
        input: createNodeInputView(input),
        basePath,
    });
}
/** 创建只供 renderer 阅读的无别名快照。函数和 Symbol 不属于模型上下文数据，
 * 转为稳定文本；普通对象/数组保留循环引用，但不保留可变原型。 */
function snapshotRendererValue(value, seen = new WeakMap()) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "function")
        return `[Function ${value.name || "anonymous"}]`;
    if (typeof value === "symbol")
        return String(value);
    if (typeof value !== "object")
        return value;
    const existing = seen.get(value);
    if (existing !== undefined)
        return existing;
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value)) {
        const clone = [];
        seen.set(value, clone);
        for (const item of value)
            clone.push(snapshotRendererValue(item, seen));
        return Object.freeze(clone);
    }
    const clone = {};
    seen.set(value, clone);
    for (const [key, item] of Object.entries(value)) {
        clone[key] = snapshotRendererValue(item, seen);
    }
    return Object.freeze(clone);
}
function snapshotMechanismContextContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        throw new TypeError("mechanism context content 必须是字符串或内容块数组");
    return Object.freeze(content.map((block) => {
        if (block?.type === "text" && typeof block.text === "string") {
            return Object.freeze({ type: "text", text: block.text });
        }
        if (block?.type === "image" && typeof block.data === "string" &&
            typeof block.mimeType === "string") {
            return Object.freeze({
                type: "image",
                data: block.data,
                mimeType: block.mimeType,
            });
        }
        throw new TypeError("mechanism context 只支持 text/image 内容块");
    }));
}
function resolveLoopGraphLimits(limits) {

    const resolved = {
        rootMaxSteps: limits?.rootMaxSteps ?? 100,
        childMaxSteps: limits?.childMaxSteps ?? 50,
        agentRunTimeoutMs: limits?.agentRunTimeoutMs ?? 5 * 60 * 1000,
        completionValidationTimeoutMs: limits?.completionValidationTimeoutMs ?? 60_000,
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
function createAgentChoiceValidator(edges, agentChoiceField, existingValidator) {
    const field = agentChoiceField ?? "chosen_edge_id";
    return async (result) => {
        // 先跑原始校验
        if (existingValidator) {
            const vr = await existingValidator(result);
            if (!vr.isValid)
                return vr;
        }
        const chosenId = result[field];
        // 未声明
        if (typeof chosenId !== "string" || chosenId.trim().length === 0) {
            const edgeList = edges
                .map((e) => `  • ${e.id} (priority: ${e.priority})${e.to === END ? " → END" : ` → ${String(e.to)}`}\n    ${e.description || "(无描述)"}`)
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
                .map((e) => `  • ${e.id} (priority: ${e.priority})${e.to === END ? " → END" : ` → ${String(e.to)}`}\n    ${e.description || "(无描述)"}`)
                .join("\n");
            return {
                isValid: false,
                reason: `边 "${chosenId}" 不存在。可选边:\n${edgeList}`,
            };
        }
        return { isValid: true };
    };
}
export function findCompactedFrameBase(branchEntries, firstKeptEntryId, frameScopes) {
    // 边界元数据缺失时不能声称已有 frame 已被 summary 覆盖；保持旧基线。
    if (!Array.isArray(branchEntries) || !firstKeptEntryId)
        return 0;
    const cut = branchEntries.findIndex((entry) => entry?.id === firstKeptEntryId);
    if (cut < 0)
        return 0;
    const scopePositions = new Map();
    for (let index = 0; index < branchEntries.length; index++) {
        const entry = branchEntries[index];
        if (entry?.type !== "custom_message" || entry?.customType !== NODE_SCOPE_TYPE)
            continue;
        const scopeId = entry?.details?.scopeId;
        if (typeof scopeId === "string")
            scopePositions.set(scopeId, index);
    }
    let compacted = 0;
    for (let frameIndex = 0; frameIndex < frameScopes.length; frameIndex++) {
        const currentPos = scopePositions.get(frameScopes[frameIndex].scopeId);
        if (currentPos == null)
            continue;
        let nextScopePos = Number.POSITIVE_INFINITY;
        for (const pos of scopePositions.values()) {
            if (pos > currentPos && pos < nextScopePos)
                nextScopePos = pos;
        }
        if (nextScopePos <= cut)
            compacted = frameIndex + 1;
    }
    return compacted;
}
/**
 * 如果节点使用 agent-choice 路由，返回一个包装后的节点，
 * 其 validateCompletion 被替换为 agent-choice 边选择校验器。
 * 否则返回原节点。
 */
function wrapWithAgentChoiceValidator(graph, nodeId, node) {
    if (node.kind !== "code")
        return node;
    const routing = graph.routing[nodeId];
    if (!routing || routing.router.kind !== "agent-choice")
        return node;
    return {
        ...node,
        validateCompletion: createAgentChoiceValidator(routing.edges, routing.agentChoiceField, node.validateCompletion),
    };
}
function getAvailableEdges(graph, nodeId) {
    const routing = graph.routing[nodeId];
    if (routing?.router.kind !== "agent-choice")
        return undefined;
    return routing.edges.map((edge) => ({
        id: edge.id,
        description: edge.description ?? "",
        priority: edge.priority,
        target: typeof edge.to === "symbol" ? "END" : String(edge.to),
    }));
}
function getAgentChoiceValidator(graph, nodeId, node) {

    if (node.kind !== "code")
        return undefined;
    const routing = graph.routing[nodeId];
    if (!routing || routing.router.kind !== "agent-choice")
        return undefined;
    return createAgentChoiceValidator(routing.edges, routing.agentChoiceField);
}
function prepareMechanismInvocations(pi, instance, node, input, localMechanisms = [], invocationGroup, eventBroker, stateStore) {

    const mechanisms = [
        ...instance.mechanisms,
        ...localMechanisms,
        ...(node.kind === "code" ? (node.mechanisms ?? []) : []),
    ];
    const active = [];
    for (const m of mechanisms) {
        if (!m.onNodeEnter && !m.onNodeExit && !m.onNodeError &&

            !m.beforeAgentRun && !m.onTurnStart && !m.onTurnEnd &&
            !m.onToolStart && !m.onToolResult && !m.beforeToolCall &&
            !m.afterToolResult && !m.validateCompletion)
            continue;
        const scope = invocationGroup.createScope(m.name);
        const stateResolution = stateStore.resolve(instance, m);
        const appendContext = (content) => {
            if (!scope.isActive())
                return false;
            const safeContent = snapshotMechanismContextContent(content);
            pi.sendMessage({
                customType: "loop_graph_mechanism",
                content: safeContent,
                display: false,
                details: Object.freeze({ protocol: 1, scopeId: scope.scopeId }),
            }, {});
            return true;
        };
        const ctx = {
            pi,
            instance,
            node,
            input,
            scope,
            events: eventBroker.createEvents(m.name, m.failurePolicy ?? "continue", scope),
            exec: eventBroker.createExec(scope),
            decisions: eventBroker.createDecisionLog(scope),
            state: stateResolution.state,
            context: Object.freeze({ append: appendContext }),
            appendContext,
        };
        active.push({
            mechanism: m,
            context: ctx,
            ...(stateResolution.initializationFailed
                ? {
                    initializationFailure: recordMechanismHookFailure(m, "createState", stateResolution.initializationError, scope.scopeId),
                }
                : {}),
        });
    }
    return active;
}
async function invokeMechanismEnterHooks(active) {
    const failures = [];
    for (const invocation of active) {
        if (invocation.initializationFailure) {
            failures.push(invocation.initializationFailure);
            continue;
        }
        const hook = invocation.mechanism.onNodeEnter;
        if (!hook)
            continue;
        try {
            await hook(invocation.context);
        }
        catch (error) {
            failures.push(recordMechanismHookFailure(invocation.mechanism, "onNodeEnter", error, invocation.context.scope.scopeId));
        }
    }
    return failures;
}
async function invokeMechanismExitHooks(active, completion) {
    const failures = [];
    const snapshot = createMechanismCompletionView(completion);
    for (const invocation of active) {
        if (invocation.initializationFailure)
            continue;
        const hook = invocation.mechanism.onNodeExit;
        if (!hook)
            continue;
        const context = Object.freeze({
            ...invocation.context,
            completion: snapshot,
        });
        try {
            await hook(context);
        }
        catch (error) {
            failures.push(recordMechanismHookFailure(invocation.mechanism, "onNodeExit", error, invocation.context.scope.scopeId));
        }
    }
    return failures;
}
async function invokeMechanismErrorHooks(active, error) {
    if (active.length === 0)
        return;
    const errorView = createMechanismErrorView(error);
    for (const invocation of active) {
        if (invocation.initializationFailure)
            continue;
        const hook = invocation.mechanism.onNodeError;
        if (!hook)
            continue;
        const context = Object.freeze({
            ...invocation.context,
            error: errorView,
        });
        try {
            await hook(context);
        }
        catch (hookError) {

            // 当前 visit 已有主错误。error hook 的 failurePolicy 只进入诊断，
            // 不能把原始失败降级、替换或制造第二条控制路径。
            recordMechanismHookFailure(invocation.mechanism, "onNodeError", hookError, invocation.context.scope.scopeId);
        }
    }
}
function recordMechanismHookFailure(mechanism, phase, error, scopeId) {
    const policy = mechanism.failurePolicy ?? "continue";
    const message = error instanceof Error ? error.message : String(error);

    const reason = `mechanism "${mechanism.name}" ${phase} 失败: ${message}`;
    debugLog.graphError(`mechanism:${mechanism.name}:${phase}`, `${reason} (policy=${policy})`);
    return {
        mechanismName: mechanism.name,
        phase,
        policy,
        error,
        reason,
        scopeId,

    };
}
function resolveMechanismControlFailure(failures) {
    return failures.find((failure) => failure.policy === "fail-graph")
        ?? failures.find((failure) => failure.policy === "fail-node")
        ?? null;
}
function createMechanismControlError(primary, failures) {
    const diagnostics = failures
        .filter((failure) => failure.policy !== "continue")
        .map((failure) => failure.reason);
    return new Error(diagnostics.length > 1
        ? `${primary.reason}; 其他机制失败: ${diagnostics.filter((reason) => reason !== primary.reason).join("; ")}`
        : primary.reason);
}
function createMechanismFailedCompletion(nodeId, primary, failures) {
    const diagnostics = failures
        .filter((failure) => failure.policy !== "continue")
        .map((failure) => Object.freeze({
        mechanismName: failure.mechanismName,
        phase: failure.phase,
        policy: failure.policy,
        reason: failure.reason,
    }));
    return {
        nodeId,
        status: "failed",
        result: {
            reason: primary.reason,
            mechanismFailure: Object.freeze({
                mechanismName: primary.mechanismName,
                phase: primary.phase,
                policy: primary.policy,
                diagnostics: Object.freeze(diagnostics),
            }),
        },
    };
}
function createMechanismCompletionView(completion) {
    return Object.freeze({
        nodeId: completion.nodeId,
        status: completion.status,
        result: snapshotRendererValue(completion.result),
        ...(completion.verifiedResult === undefined
            ? {}
            : {
                verifiedResult: snapshotRendererValue(completion.verifiedResult),
            }),
    });
}
function createMechanismErrorView(error) {
    if (error instanceof Error) {
        return Object.freeze({
            name: error.name,
            message: error.message,
            ...(error.stack ? { stack: error.stack } : {}),
        });
    }
    return Object.freeze({
        name: "NonErrorThrow",
        message: String(error),
    });
}
async function execNodeInGraph(runtime, nodeContext, node, input, runSubgraph) {
    if (node.kind === "graph") {
        debugLog.subgraphPush(node.id, node.graph.id);
        const result = await runSubgraph(node, input.data);
        debugLog.subgraphPop(node.id, node.graph.id, result);
        return result;
    }
    return node.execute(runtime.topInstance, input, nodeContext);
}
// ── 工具管理 ────────────────────────────────────────────────
function saveActiveTools(pi) {
    try {
        return pi.getActiveTools?.() ?? ["read"];
    }
    catch {
        return ["read"];
    }
}
function restoreActiveTools(pi, tools) {
    pi.setActiveTools(tools);
}
function restoreDefaultTools(pi) {
    pi.setActiveTools(["read"]);
}






