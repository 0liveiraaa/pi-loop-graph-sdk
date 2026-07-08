// ============================================================
//  Loop Graph Extension — pi 入口
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentInstance, Edge, Graph, Node, NodeCompletion, NodeInput, NodeRouting } from "../type.js";
import { END } from "../type.js";
import { GraphRuntime } from "../runtime.js";
import { projectMessages } from "./projection.js";
import { PiNodeContext } from "./pi-node-context.js";
import { COMPLETE_TOOL_NAME, createCompleteTool } from "./complete-tool.js";
import { debugLog } from "./debug-log.js";
import { reviewGraph } from "../graphs/review-graph.js";
import { probeGraph } from "../graphs/probe-graph.js";
import { chainGraph } from "../graphs/chain-graph.js";
import { subgraphGraph } from "../graphs/subgraph-graph.js";

const BOUNDARY_TYPE = "loop_graph_boundary";

let activeRuntime: GraphRuntime | null = null;
let activeNodeContext: PiNodeContext | null = null;

export default function loopGraphExtension(pi: ExtensionAPI) {
  pi.registerTool(createCompleteTool());
  registerGraph(pi, reviewGraph);
  registerGraph(pi, probeGraph);
  registerGraph(pi, chainGraph);
  registerGraph(pi, subgraphGraph);

  // context 投影
  (pi as any).on("context", (e: any) => {
    const rt = activeRuntime;
    if (!rt?.isNodeActive) return;

    const input = {
      messages: e.messages as any[],
      frames: rt.topInstance?.frames ?? [],
      currentNode: rt.currentNode,
      currentInput: rt.currentInput,
      nodeMarker: rt.nodeMarker,
    };
    const projected = projectMessages(input);
    debugLog.projection(input, projected as any[]);
    return { messages: projected };
  });

  // 捕获 __graph_complete__
  pi.on("tool_result", (event) => {
    if (event.toolName !== COMPLETE_TOOL_NAME || !activeNodeContext) return;
    const params = event.details as any;
    if (params?.status) {
      debugLog.agentComplete(activeNodeContext["currentNodeId"] ?? "?", {
        nodeId: activeNodeContext["currentNodeId"] ?? "?",
        status: params.status,
        result: params.result ?? {},
      });
      activeNodeContext.recordCompletion({
        status: params.status,
        result: params.result ?? {},
      });
    }
  });

  pi.on("agent_end", () => {
    activeNodeContext?.onAgentEnd();
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Loop Graph Extension 已加载", "info");
  });
}

// ═══════════════════════════════════════════════════════════

const graphs = new Map<string, Graph>();

function registerGraph(pi: ExtensionAPI, graph: Graph): void {
  graphs.set(graph.id, graph);
  const inv = graph.invocation;
  if (!inv) return;
  pi.registerCommand(inv.name, {
    description: inv.description,
    handler: async (args, ctx) => {
      ctx.ui.notify(`启动图: ${graph.id}`, "info");
      await executeGraph(pi, graph, { source: "command", args });
    },
  });
}

// ═══════════════════════════════════════════════════════════

async function executeGraph(
  pi: ExtensionAPI,
  graph: Graph,
  trigger: { source: string; args?: string; params?: Record<string, unknown> },
): Promise<void> {
  const runtime = new GraphRuntime();
  const nodeContext = new PiNodeContext(pi);

  debugLog.graphStart(graph.id, trigger);

  const prevRt = activeRuntime;
  const prevNc = activeNodeContext;
  activeRuntime = runtime;
  activeNodeContext = nodeContext;

  try {
    const background = trigger.source === "tool" ? (trigger.params ?? {}) : { args: trigger.args ?? "" };
    const entry = graph.entries.find((e) => { try { return e.guard(background); } catch { return false; } });
    if (!entry) {
      pi.sendMessage({ customType: "loop_graph_error", content: `无匹配入口: ${JSON.stringify(background)}`, display: true });
      return;
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

      const prevTools = saveActiveTools(pi);
      setNodeTools(pi, node);
      debugLog.toolsChanged(nodeId, ["read", ...(node.kind === "code" ? (node.tools ?? []) : []), COMPLETE_TOOL_NAME]);

      const marker = runtime.nextMarker(nodeId);
      pi.sendMessage({ customType: BOUNDARY_TYPE, content: marker, display: false });

      runtime.enterNode(nodeId, marker, input);
      debugLog.enterNode(runtime.callStack.length, nodeId, marker, input, runtime.topInstance?.frames ?? []);
      nodeContext.setCurrentNodeId(nodeId);

      const completion = await execNode(pi, runtime, nodeContext, node, input);

      const routing = graph.routing[nodeId];
      if (!routing) throw new Error(`节点 ${nodeId} 无路由`);
      const edge = selectEdge(routing, completion, runtime.topInstance!);
      if (!edge) throw new Error(`无边匹配 ${nodeId}: status=${completion.status}`);

      const migration = edge.migrate(runtime.topInstance!, completion);
      runtime.exitNode(migration.frame);
      debugLog.exitNode(runtime.callStack.length, nodeId, migration.frame, runtime.topInstance?.frames ?? []);

      restoreActiveTools(pi, prevTools);

      if (edge.to === END) {
        pi.sendMessage({ customType: "loop_graph_complete", content: `图完成（${step + 1} 步）`, display: true });
        debugLog.graphEnd(graph.id, step + 1, runtime.topInstance?.frames ?? []);
        break;
      }

      nodeId = edge.to as string;
      input = { data: migration.input ?? {}, source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from } };
    }
  } catch (error) {
    debugLog.graphError(graph.id, error instanceof Error ? error.message : String(error));
    pi.sendMessage({ customType: "loop_graph_error", content: `图运行错误: ${error instanceof Error ? error.message : String(error)}`, display: true });
  } finally {
    runtime.reset();
    nodeContext.reset();
    restoreDefaultTools(pi);
    activeRuntime = prevRt;
    activeNodeContext = prevNc;
  }
}

// ── 节点执行 ──

async function execNode(
  pi: ExtensionAPI,
  runtime: GraphRuntime,
  nodeContext: PiNodeContext,
  node: Node,
  input: NodeInput,
): Promise<NodeCompletion> {
  if (node.kind === "graph") {
    debugLog.subgraphPush(node.id, node.graph.id);
    const result = await runSubgraph(pi, node, input.data);
    debugLog.subgraphPop(node.id, node.graph.id, result);
    return result;
  }

  if (node.skill || (node.tools?.length ?? 0) > 0) {
    return nodeContext.runAgent({ prompt: `开始执行: ${node.subGoal}`, tools: node.tools, skill: node.skill });
  }
  return node.execute(runtime.topInstance!, input, nodeContext);
}

// ── 子图 ──

async function runSubgraph(
  pi: ExtensionAPI,
  graphNode: { id: string; subGoal: string; graph: Graph },
  background: Record<string, unknown>,
): Promise<NodeCompletion> {
  const childRt = new GraphRuntime();
  const childNc = new PiNodeContext(pi);
  const childGraph = graphNode.graph;

  const prevRt = activeRuntime;
  const prevNc = activeNodeContext;
  activeRuntime = childRt;
  activeNodeContext = childNc;

  try {
    childRt.pushGraph(childGraph, background);
    const entry = childGraph.entries.find((e) => { try { return e.guard(background); } catch { return false; } });
    if (!entry) throw new Error(`子图 ${childGraph.id} 无匹配入口`);

    let nodeId = entry.startNodeId;
    let input: NodeInput = {
      data: entry.mapInput ? entry.mapInput(background) : background,
      source: { kind: "entry", entryId: entry.id },
    };

    for (let step = 0; step < 50; step++) {
      const node = childGraph.nodes[nodeId];
      if (!node) throw new Error(`子图节点未找到: ${nodeId}`);

      const prevTools = saveActiveTools(pi);
      setNodeTools(pi, node);

      const marker = childRt.nextMarker(nodeId);
      pi.sendMessage({ customType: BOUNDARY_TYPE, content: marker, display: false });

      childRt.enterNode(nodeId, marker, input);
      debugLog.enterNode(childRt.callStack.length, nodeId, marker, input, childRt.topInstance?.frames ?? []);
      childNc.setCurrentNodeId(nodeId);

      const completion = await execNode(pi, childRt, childNc, node, input);

      const routing = childGraph.routing[nodeId];
      if (!routing) throw new Error(`子图 ${nodeId} 无路由`);
      const edge = selectEdge(routing, completion, childRt.topInstance!);
      if (!edge) throw new Error(`子图无边匹配 ${nodeId}`);

      const migration = edge.migrate(childRt.topInstance!, completion);
      childRt.exitNode(migration.frame);
      debugLog.exitNode(childRt.callStack.length, nodeId, migration.frame, childRt.topInstance?.frames ?? []);
      restoreActiveTools(pi, prevTools);

      if (edge.to === END) break;

      nodeId = edge.to as string;
      input = { data: migration.input ?? {}, source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from } };
    }

    const childInstance = childRt.topInstance!;
    const lastFrame = childInstance.frames[childInstance.frames.length - 1];
    return {
      nodeId: graphNode.id,
      status: lastFrame?.status ?? "failed",
      result: { childFrames: childInstance.frames, finalResult: lastFrame?.result ?? {} },
    };
  } finally {
    childRt.reset();
    childNc.reset();
    restoreDefaultTools(pi);
    activeRuntime = prevRt;
    activeNodeContext = prevNc;
  }
}

// ── 工具管理 ──

function saveActiveTools(pi: ExtensionAPI): string[] {
  try { return (pi as any).getActiveTools?.() ?? ["read"]; } catch { return ["read"]; }
}
function setNodeTools(pi: ExtensionAPI, node: Node): void {
  const t = node.kind === "code" ? (node.tools ?? []) : [];
  pi.setActiveTools(["read", ...t, COMPLETE_TOOL_NAME]);
}
function restoreActiveTools(pi: ExtensionAPI, tools: string[]): void { pi.setActiveTools(tools); }
function restoreDefaultTools(pi: ExtensionAPI): void { pi.setActiveTools(["read"]); }

// ── 路由 ──

function selectEdge(routing: NodeRouting, completion: NodeCompletion, instance: AgentInstance): Edge | null {
  const matched = routing.edges.filter((e) => { try { return e.guard(completion); } catch { return false; } });
  if (matched.length === 0) return null;
  switch (routing.router.kind) {
    case "first-match": return matched[0] ?? null;
    case "priority-first": return [...matched].sort((a, b) => b.priority - a.priority)[0] ?? null;
    case "custom": return (routing.router.fn(matched, completion, instance) as Edge | null) ?? null;
    case "agent-choice": throw new Error("agent-choice 未实现");
    default: return matched[0] ?? null;
  }
}
