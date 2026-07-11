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
import type { GraphRunResult } from "./graph-execution-host.js";
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
    assertValidGraph(graph);

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
      const entry = graph.entries.find((e) => {
        try { return e.guard(background); } catch { return false; }
      });
      if (!entry) {
        piInner.sendMessage({
          customType: "loop_graph_error",
          content: `无匹配入口: ${JSON.stringify(background)}`,
          display: true,
        });
        return {
          graphId: graph.id,
          status: "failed",
          result: { reason: `无匹配入口: ${JSON.stringify(background)}` },
          steps: 0,
        };
      }

      runtime.pushGraph(graph, background);
      let nodeId = entry.startNodeId;
      let input: NodeInput = {
        data: entry.mapInput ? entry.mapInput(background) : background,
        source: { kind: "entry", entryId: entry.id },
      };

      for (let step = 0; step < 100; step++) {
        const node = graph.nodes[nodeId];
        if (!node) throw new Error(`节点未找到: ${nodeId}`);

        const prevTools = saveActiveTools(piInner);
        setNodeToolsForInstance(piInner, node);
        debugLog.toolsChanged(nodeId, piInner.getActiveTools());

        const scope = runtime.nextScope(nodeId);
        appendNodeScope(piInner, node, scope, getAvailableEdges(graph, nodeId));

        // 追加 skill 内容（NodeScope 之后，属于本节点 active 段，离开后随 ReAct 折叠）
        appendSkillContent(piInner, node);

        runtime.enterNode(nodeId, scope, input);
        debugLog.enterNode(
          runtime.callStack.length,
          nodeId,
          scope.scopeId,
          input,
          runtime.topInstance?.frames ?? [],
        );
        nodeContext.setCurrentNodeId(nodeId);

        // 横切机制：节点进入后、execute 之前分派（预处理 scratch / 追加上下文） 机制应该是存在agent调用的节点在agent运行时工作的代码,类似hook机制,否则会和hybird节点打架,两者似乎是同一功能
        await applyMechanisms(piInner, runtime.topInstance!, node, input);

        // agent-choice 路由：注入边选择校验，agent 未正确声明 chosen_edge_id 时驳回重试
        const effectiveNode = wrapWithAgentChoiceValidator(graph, nodeId, node);

        const completion = await execNodeInGraph(
          piInner,
          runtime,
          nodeContext,
          effectiveNode,
          input,
          runSubgraphInExtension,
        );

        const routing = graph.routing[nodeId];
        if (!routing) throw new Error(`节点 ${nodeId} 无路由`);
        const edge = await selectEdge(routing, completion, runtime.topInstance!);
        if (!edge) {
          runtime.exitNode({
            nodeId: completion.nodeId,
            status: completion.status,
            summary: `${nodeId} 完成(${completion.status})，无匹配边，图结束`,
            result: completion.result,
          });
          piInner.sendMessage({
            customType: "loop_graph_complete",
            content: `图结束（无边匹配 ${nodeId}）`,
            display: true,
          });
          return {
            graphId: graph.id,
            status: completion.status,
            result: completion.result,
            steps: step + 1,
          };
        }

        const migration = edge.migrate(runtime.topInstance!, completion);
        runtime.exitNode(migration.frame);
        debugLog.exitNode(
          runtime.callStack.length,
          nodeId,
          migration.frame,
          runtime.topInstance?.frames ?? [],
        );

        restoreActiveTools(piInner, prevTools);

        if (edge.to === END) {
          piInner.sendMessage({
            customType: "loop_graph_complete",
            content: `图完成（${step + 1} 步）`,
            display: true,
          });
          debugLog.graphEnd(graph.id, step + 1, runtime.topInstance?.frames ?? []);
          return {
            graphId: graph.id,
            status: migration.frame.status,
            result: migration.frame.result,
            steps: step + 1,
          };
        }

        nodeId = edge.to as string;
        input = {
          data: migration.input ?? {},
          source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
        };
      }

      return {
        graphId: graph.id,
        status: "failed",
        result: { reason: "Max steps (100) exceeded" },
        steps: 100,
      };
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

  async function runSubgraphInExtension(
    piInner: ExtensionAPI,
    graphNode: { id: string; subGoal: string; graph: Graph },
    background: Record<string, unknown>,
  ): Promise<NodeCompletion> {
    const childRt = new GraphRuntime();
    const childNc = new PiNodeContext(piInner);
    const childGraph = graphNode.graph;

    const prevRt = activeRuntime;
    const prevNc = activeNodeContext;
    activeRuntime = childRt;
    activeNodeContext = childNc;

    try {
      childRt.pushGraph(childGraph, background);
      const entry = childGraph.entries.find((e) => {
        try { return e.guard(background); } catch { return false; }
      });
      if (!entry) throw new Error(`子图 ${childGraph.id} 无匹配入口`);

      let nodeId = entry.startNodeId;
      let input: NodeInput = {
        data: entry.mapInput ? entry.mapInput(background) : background,
        source: { kind: "entry", entryId: entry.id },
      };

      for (let step = 0; step < 50; step++) {
        const node = childGraph.nodes[nodeId];
        if (!node) throw new Error(`子图节点未找到: ${nodeId}`);

        const prevTools = saveActiveTools(piInner);
        setNodeToolsForInstance(piInner, node);

        const scope = childRt.nextScope(nodeId);
        appendNodeScope(piInner, node, scope, getAvailableEdges(childGraph, nodeId));

        // 追加 skill 内容（NodeScope 之后，属于本节点 active 段）
        appendSkillContent(piInner, node);

        childRt.enterNode(nodeId, scope, input);
        debugLog.enterNode(
          childRt.callStack.length,
          nodeId,
          scope.scopeId,
          input,
          childRt.topInstance?.frames ?? [],
        );
        childNc.setCurrentNodeId(nodeId);

        // 横切机制：子图节点同样在进入后、execute 之前分派
        await applyMechanisms(piInner, childRt.topInstance!, node, input);

        // agent-choice 路由：注入边选择校验
        const effectiveNode = wrapWithAgentChoiceValidator(childGraph, nodeId, node);

        const completion = await execNodeInGraph(
          piInner,
          childRt,
          childNc,
          effectiveNode,
          input,
          runSubgraphInExtension,
        );

        const routing = childGraph.routing[nodeId];
        if (!routing) throw new Error(`子图 ${nodeId} 无路由`);
        const edge = await selectEdge(routing, completion, childRt.topInstance!);
        if (!edge) {
          childRt.exitNode({
            nodeId: completion.nodeId,
            status: completion.status,
            summary: `子图 ${nodeId} 完成(${completion.status})，无匹配边`,
            result: completion.result,
          });
          break;
        }

        const migration = edge.migrate(childRt.topInstance!, completion);
        childRt.exitNode(migration.frame);
        debugLog.exitNode(
          childRt.callStack.length,
          nodeId,
          migration.frame,
          childRt.topInstance?.frames ?? [],
        );
        restoreActiveTools(piInner, prevTools);

        if (edge.to === END) break;

        nodeId = edge.to as string;
        input = {
          data: migration.input ?? {},
          source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
        };
      }

      const childInstance = childRt.topInstance!;
      const lastFrame = childInstance.frames[childInstance.frames.length - 1];
      return {
        nodeId: graphNode.id,
        status: lastFrame?.status ?? "failed",
        result: lastFrame?.result ?? {},
      };
    } finally {
      childRt.reset();
      childNc.reset();
      restoreDefaultTools(piInner);
      activeRuntime = prevRt;
      activeNodeContext = prevNc;
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
): Promise<void> {
  const mechanisms: Mechanism[] = [
    ...instance.mechanisms,
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
  pi: ExtensionAPI,
  runtime: GraphRuntime,
  nodeContext: PiNodeContext,
  node: Node,
  input: NodeInput,
  runSubgraph: (
    pi: ExtensionAPI,
    graphNode: { id: string; subGoal: string; graph: Graph },
    background: Record<string, unknown>,
  ) => Promise<NodeCompletion>,
): Promise<NodeCompletion> {
  if (node.kind === "graph") {
    debugLog.subgraphPush(node.id, node.graph.id);
    const result = await runSubgraph(pi, node, input.data);
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
