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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { buildNodeInfoContent, projectMessages, type EdgeChoice } from "./projection.js";
import { PiNodeContext } from "./pi-node-context.js";
import { COMPLETE_TOOL_NAME, createCompleteTool } from "./complete-tool.js";
import { resolveNodeTools } from "../tools-resolve.js";
import { debugLog } from "./debug-log.js";
import { GraphRegistry } from "../registry.js";
import { reviewGraph } from "../graphs/review-graph.js";
import { probeGraph } from "../graphs/probe-graph.js";
import { chainGraph } from "../graphs/chain-graph.js";
import { subgraphGraph } from "../graphs/subgraph-graph.js";
import { validateGraph as validateTestGraph } from "../graphs/validate-graph.js";

import * as fs from "node:fs";
import * as path from "node:path";

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
  ): Promise<GraphRunResult>;
}

// ── 工厂函数 ───────────────────────────────────────────────

export function createLoopGraphExtension(
  pi: ExtensionAPI,
  options: LoopGraphExtensionOptions = {},
): LoopGraphExtension {
  // ── 实例级状态（替代原模块级 activeRuntime / activeNodeContext）──

  let activeRuntime: GraphRuntime | null = null;
  let activeNodeContext: PiNodeContext | null = null;
  const defaultTools = options.defaultTools ?? [];
  const skillBasePath = options.skillBasePath ?? path.join(process.cwd(), "skills");

  /** 已完成工具存在性校验的图 ID（首次 executeGraph 时校验一次） */
  const toolValidated = new Set<string>();

  // ── 实例级图注册表（替代原全局 graphs Map）──

  const registry = new GraphRegistry(pi, executeGraph);

  // ── 注册 __graph_complete__ 工具 ──

  if (!completeToolRegistered.has(pi as object)) {
    pi.registerTool(createCompleteTool());
    completeToolRegistered.add(pi as object);
  }

  // ── 注册钩子 ──

  // context 投影钩子
  (pi as any).on("context", (e: any) => {
    const rt = activeRuntime;
    if (!rt?.isNodeActive) return;

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
      messages: e.messages as any[],
      frames: rt.topInstance?.frames ?? [],
      currentNode: rt.currentNode,
      activeScope: rt.currentScope,
      availableEdges,
      frameFormatter: options.frameFormatter,
    };
    const projected = projectMessages(input);
    debugLog.projection(input, projected as any[]);
    return { messages: projected };
  });

  // compaction 会移除旧 transcript，因而可能带走活动 NodeScope。压缩完成后
  // 在消息流末尾重发相同 scopeId 的 checkpoint；下一次（包括 overflow retry）
  // 的严格投影将从此处开始，而不会回退到 compaction summary 或外层消息。
  (pi as any).on("session_compact", (event: any) => {
    const rt = activeRuntime;
    const node = rt?.currentNode;
    const scope = rt?.currentScope;
    const graph = rt?.topGraph;
    const nodeId = rt?.currentNodeId;
    if (!rt?.isNodeActive || !node || !scope || !graph || !nodeId) return;

    const generation = rt.recordCompaction();
    appendNodeScope(pi, node, scope, getAvailableEdges(graph, nodeId));
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
    }
  });

  // agent 结束 → resolve Promise
  pi.on("agent_end", () => {
    activeNodeContext?.onAgentEnd();
  });

  // session 启动通知
  if (!options.runtimeOnly) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Loop Graph Extension 已加载", "info");
    });
  }

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
  ): Promise<GraphRunResult> {
    // Phase 8 已接线 compose；delegate 仍必须明确拒绝，不能悄悄按 call 执行。
    assertValidGraph(graph, {
      supportedBoundaries: ["call", "compose"],
      delegateHostAvailable: false,
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
    const nodeContext = new PiNodeContext(piInner);

    debugLog.graphStart(graph.id, trigger);

    // 保存/恢复外层运行时状态（支持子图嵌套时切换 activeRuntime）
    const prevRt = activeRuntime;
    const prevNc = activeNodeContext;
    activeRuntime = runtime;
    activeNodeContext = nodeContext;

    try {
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
        maxSteps: 100,
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
        `[系统] 图 "${graph.id}" 因错误意外终止：${reason}。当前节点已失效，请停止相关图工作。`,
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
    executeGraph(graph, trigger) {
      return executeGraph(pi, graph, trigger);
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
  }

  /**
   * 同一 Session 内 root、call 与 compose 的唯一执行循环。它只编排节点、边和 frames，
   * 不负责命令/tool UI 或 AgentSession host 生命周期。
   */
  async function runGraphLoop(request: RunGraphLoopRequest): Promise<GraphRunResult> {
    const { runtime, nodeContext, graph, background, boundary, maxSteps, sharedInstance, parentNodeId } = request;
    const entry = graph.entries.find((candidate) => {
      try { return candidate.guard(background); } catch { return false; }
    });
    if (!entry) {
      if (boundary === "call") {
        throw new Error(`子图 ${graph.id} 无匹配入口`);
      }
      return {
        graphId: graph.id,
        status: "failed",
        result: { reason: `无匹配入口: ${JSON.stringify(background)}` },
        steps: 0,
      };
    }

    const instance = runtime.pushGraph(graph, background, boundary, sharedInstance, parentNodeId);
    let nodeId = entry.startNodeId;
    let input: NodeInput = {
      data: entry.mapInput ? entry.mapInput(background) : background,
      source: { kind: "entry", entryId: entry.id },
    };

    const finish = (result: GraphRunResult): GraphRunResult => {
      debugLog.graphEnd(graph.id, result.steps, instance.frames);
      return result;
    };

    try {
      for (let step = 0; step < maxSteps; step++) {
        const node = graph.nodes[nodeId];
        if (!node) throw new Error(`节点未找到: ${nodeId}`);

        const previousTools = saveActiveTools(pi);
        try {
          setNodeToolsForInstance(pi, node);
          debugLog.toolsChanged(nodeId, pi.getActiveTools());

          const scope = runtime.nextScope(nodeId);
          appendNodeScope(pi, node, scope, getAvailableEdges(graph, nodeId));
          appendSkillContent(pi, node);

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
          const effectiveNode = wrapWithAgentChoiceValidator(graph, nodeId, node);
          const completion = await execNodeInGraph(
            runtime,
            nodeContext,
            effectiveNode,
            input,
            async (graphNode, callBackground) => {
              const graphBoundary = graphNode.boundary ?? "call";
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
                    maxSteps: 50,
                    sharedInstance: parentInstance,
                    parentNodeId: graphNode.id,
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
                maxSteps: 50,
                parentNodeId: graphNode.id,
              });
              return { nodeId: graphNode.id, status: child.status, result: child.result };
            },
          );

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
            debugLog.exitNode(runtime.callStack.length, nodeId, frame, instance.frames);
            return finish({
              graphId: graph.id,
              status: completion.status,
              result: completion.result,
              steps: step + 1,
            });
          }

          const migration = edge.migrate(runtime.topInstance!, completion);
          runtime.exitNode(migration.frame);
          debugLog.exitNode(
            runtime.callStack.length,
            nodeId,
            migration.frame,
            instance.frames,
          );

          if (edge.to === END) {
            return finish({
              graphId: graph.id,
              status: migration.frame.status,
              result: migration.frame.result,
              steps: step + 1,
            });
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

      return finish({
        graphId: graph.id,
        status: "failed",
        result: { reason: `Max steps (${maxSteps}) exceeded` },
        steps: maxSteps,
      });
    } finally {
      runtime.popGraph();
    }
  }

  function setNodeToolsForInstance(piInner: ExtensionAPI, node: Node): void {
    const nodeTools = node.kind === "code" ? (node.tools ?? []) : [];
    piInner.setActiveTools(resolveNodeTools(defaultTools, nodeTools));
  }

  /**
   * 节点声明了 skill 时，读取 SKILL.md 追加到消息流。
   * 必须在 NodeScope 之后调用，确保内容属于当前节点的 active 段。
   */
  function appendSkillContent(piInner: ExtensionAPI, node: Node): void {
    if (node.kind !== "code" || !node.skill) return;

    const skillDir = path.join(skillBasePath, node.skill);
    const skillFile = path.join(skillDir, "SKILL.md");

    if (!fs.existsSync(skillFile)) {
      debugLog.graphError(
        `skill:${node.skill}`,
        `SKILL.md 未找到: ${skillFile}`,
      );
      return;
    }

    try {
      const content = fs.readFileSync(skillFile, "utf-8");
      // 用 sendMessage 追加入消息流，不触发 turn。
      // sendUserMessage 语义是"发起一轮"，会触发额外 turn，
      // 在 runAgent 之前调用会造成 turn 竞跑。
      piInner.sendMessage({
        customType: "loop_graph_skill",
        content: `[skill: ${node.skill}]\n\n${content}`,
        display: false,
      });
    } catch (err) {
      debugLog.graphError(
        `skill:${node.skill}`,
        `读取失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function appendNodeScope(
    piInner: ExtensionAPI,
    node: Node,
    scope: import("../runtime.js").NodeScopeDescriptor,
    availableEdges?: EdgeChoice[],
  ): void {
    piInner.sendMessage({
      customType: NODE_SCOPE_TYPE,
      content: buildNodeInfoContent(node, availableEdges),
      details: scope,
      display: false,
    });
  }
}//开发者注释:关于子图调用部分能否更合理的安排代码,使得其复用顶层图的大部分代码,而不是重新敲一遍

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
