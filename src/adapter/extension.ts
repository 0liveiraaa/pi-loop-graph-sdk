// ============================================================
//  Loop Graph Extension — pi 入口
// ============================================================
//
//  核心机制：
//    1. context 钩子投影 — 每次 LLM 调用时动态组装 frame + 活跃段
//    2. Promise 桥接 — runAgent 内 await agent_end
//    3. 调用栈 — GraphRuntime.callStack 实现子图隔离
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Edge, Graph, NodeCompletion, NodeInput, NodeRouting } from "../type.js";
import { END } from "../type.js";
import { GraphRuntime } from "../runtime.js";
import { projectMessages } from "./projection.js";
import { PiNodeContext } from "./pi-node-context.js";
import { COMPLETE_TOOL_NAME, createCompleteTool } from "./complete-tool.js";
import { reviewGraph } from "../graphs/review-graph.js";

// ── 模块级单例（context 钩子 + 命令 handler 共享）───────
let activeRuntime: GraphRuntime | null = null;
let activeNodeContext: PiNodeContext | null = null;

export default function loopGraphExtension(pi: ExtensionAPI) {
  const runtime = new GraphRuntime();
  const nodeContext = new PiNodeContext(pi);

  pi.registerTool(createCompleteTool());
  registerGraph(pi, reviewGraph);

  // ═══════════════════════════════════════════════════════
  //  context 钩子 — 投影
  // ═══════════════════════════════════════════════════════

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("context", (_event: any) => {
    const rt = activeRuntime;
    if (!rt || !rt.isNodeActive) return;

    const messages = _event.messages as any[];
    if (!messages || !Array.isArray(messages)) return;

    const projected = projectMessages({
      messages,
      frames: rt.topInstance?.frames ?? [],
      currentNode: rt.currentNode,
      currentInput: rt.currentInput,
      nodeStartEntryId: rt.nodeStartEntryId,
    });

    return { messages: projected };
  });

  // ═══════════════════════════════════════════════════════
  //  tool_result — 捕获 __graph_complete__
  // ═══════════════════════════════════════════════════════

  pi.on("tool_result", (event) => {
    if (event.toolName !== COMPLETE_TOOL_NAME) return;
    const params = event.details as any;
    if (params?.status && activeNodeContext) {
      activeNodeContext.recordCompletion({
        status: params.status,
        result: params.result ?? {},
      });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  agent_end — Promise 桥接
  // ═══════════════════════════════════════════════════════

  pi.on("agent_end", () => {
    if (activeNodeContext) activeNodeContext.onAgentEnd();
  });

  // ═══════════════════════════════════════════════════════

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
//  Runtime 主循环
// ═══════════════════════════════════════════════════════════

async function executeGraph(
  pi: ExtensionAPI,
  graph: Graph,
  trigger: { source: string; args?: string; params?: Record<string, unknown> },
): Promise<void> {
  const runtime = new GraphRuntime();
  const nodeContext = new PiNodeContext(pi);

  activeRuntime = runtime;
  activeNodeContext = nodeContext;

  try {
    const background: Record<string, unknown> =
      trigger.source === "tool"
        ? (trigger.params ?? {})
        : { args: trigger.args ?? "" };

    const entry = graph.entries.find((e) => {
      try { return e.guard(background); } catch { return false; }
    });
    if (!entry) {
      pi.sendMessage({
        customType: "loop_graph_error",
        content: `无匹配入口: ${JSON.stringify(background)}`,
        display: true,
      });
      return;
    }

    runtime.pushGraph(graph, background);
    let nodeId = entry.startNodeId;
    let input: NodeInput = {
      data: entry.mapInput ? entry.mapInput(background) : background,
      source: { kind: "entry", entryId: entry.id },
    };

    const MAX = 100;
    for (let step = 0; step < MAX; step++) {
      const node = runtime.topGraph?.nodes[nodeId];
      if (!node) throw new Error(`节点未找到: ${nodeId}`);

      const nodeTools = node.kind === "code" ? (node.tools ?? []) : [];
      pi.setActiveTools(["read", ...nodeTools, COMPLETE_TOOL_NAME]);

      const leafId = getLeafId(pi);
      runtime.enterNode(nodeId, input, leafId);
      nodeContext.setCurrentNodeId(nodeId);

      let completion: NodeCompletion;

      if (node.kind === "code") {
        const isAgent = !!(node.skill || (node.tools?.length ?? 0) > 0);
        if (isAgent) {
          completion = await nodeContext.runAgent({
            prompt: `开始执行: ${node.subGoal}`,
            tools: node.tools,
            skill: node.skill,
          });
        } else {
          completion = await node.execute(
            runtime.topInstance!,
            input,
            nodeContext,
          );
        }
      } else {
        completion = await runSubgraph(pi, runtime, node);
      }

      const newLeafId = getLeafId(pi);
      const routing = graph.routing[nodeId];
      if (!routing) throw new Error(`节点 ${nodeId} 无路由`);

      const edge = selectEdge(routing, completion, runtime.topInstance!);
      if (!edge) throw new Error(`无边匹配 ${nodeId}: status=${completion.status}`);

      const migration = edge.migrate(runtime.topInstance!, completion);
      runtime.exitNode(migration.frame, newLeafId);

      if (edge.to === END) {
        pi.sendMessage({
          customType: "loop_graph_complete",
          content: `图完成（${step + 1} 步, ${runtime.topInstance!.frames.length} 帧）`,
          display: true,
        });
        break;
      }

      nodeId = edge.to as string;
      input = {
        data: migration.input ?? {},
        source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
      };
      pi.setActiveTools(["read"]);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    pi.sendMessage({
      customType: "loop_graph_error",
      content: `图运行错误: ${msg}`,
      display: true,
    });
  } finally {
    runtime.reset();
    nodeContext.reset();
    pi.setActiveTools(["read"]);
    activeRuntime = null;
    activeNodeContext = null;
  }
}

// ── 子图 ──────────────────────────────────────────────────

async function runSubgraph(
  pi: ExtensionAPI,
  parentRuntime: GraphRuntime,
  graphNode: { id: string; subGoal: string; graph: Graph },
): Promise<NodeCompletion> {
  const childRuntime = new GraphRuntime();
  const childNodeContext = new PiNodeContext(pi);
  const childGraph = graphNode.graph;
  const background = parentRuntime.currentInput?.data ?? {};

  // 切换活跃 runtime 到子图（context 钩子读 activeRuntime）
  const prevRuntime = activeRuntime;
  const prevNodeContext = activeNodeContext;
  activeRuntime = childRuntime;
  activeNodeContext = childNodeContext;

  try {
    childRuntime.pushGraph(childGraph, background);

    const entry = childGraph.entries[0];
    if (!entry) throw new Error(`子图 ${childGraph.id} 无入口`);

    let nodeId = entry.startNodeId;
    let input: NodeInput = {
      data: entry.mapInput ? entry.mapInput(background) : background,
      source: { kind: "entry", entryId: entry.id },
    };

    const MAX = 50;
    for (let step = 0; step < MAX; step++) {
      const node = childGraph.nodes[nodeId];
      if (!node) throw new Error(`子图节点未找到: ${nodeId}`);

      const nodeTools = node.kind === "code" ? (node.tools ?? []) : [];
      pi.setActiveTools(["read", ...nodeTools, COMPLETE_TOOL_NAME]);

      const leafId = getLeafId(pi);
      childRuntime.enterNode(nodeId, input, leafId);
      childNodeContext.setCurrentNodeId(nodeId);

      let completion: NodeCompletion;
      if (node.kind === "graph") {
        completion = await runSubgraph(pi, childRuntime, node);
      } else {
        const isAgent = !!(node.skill || (node.tools?.length ?? 0) > 0);
        if (isAgent) {
          completion = await childNodeContext.runAgent({
            prompt: `开始执行: ${node.subGoal}`,
            tools: node.tools,
            skill: node.skill,
          });
        } else {
          completion = await node.execute(
            childRuntime.topInstance!,
            input,
            childNodeContext,
          );
        }
      }

      const newLeafId = getLeafId(pi);
      const routing = childGraph.routing[nodeId];
      if (!routing) throw new Error(`子图 ${nodeId} 无路由`);

      const edge = selectEdge(routing, completion, childRuntime.topInstance!);
      if (!edge) throw new Error(`子图无边匹配 ${nodeId}`);

      const migration = edge.migrate(childRuntime.topInstance!, completion);
      childRuntime.exitNode(migration.frame, newLeafId);

      if (edge.to === END) break;

      nodeId = edge.to as string;
      input = {
        data: migration.input ?? {},
        source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
      };
      pi.setActiveTools(["read"]);
    }

    const childInstance = childRuntime.topInstance!;
    return {
      nodeId: graphNode.id,
      status: "ok",
      result: {
        childFrames: childInstance.frames,
        finalResult:
          childInstance.frames.length > 0
            ? childInstance.frames[childInstance.frames.length - 1].result
            : {},
      },
    };
  } finally {
    childRuntime.reset();
    childNodeContext.reset();
    pi.setActiveTools(["read"]);
    activeRuntime = prevRuntime;
    activeNodeContext = prevNodeContext;
  }
}

// ── 工具函数 ──────────────────────────────────────────────

function getLeafId(pi: ExtensionAPI): string {
  try {
    const sm = (pi as any).sessionManager;
    if (sm?.getLeafEntry) {
      const leaf = sm.getLeafEntry();
      return leaf?.id ?? "";
    }
  } catch { /* ignore */ }
  return "";
}

function selectEdge(
  routing: NodeRouting,
  completion: NodeCompletion,
  instance: any,
): Edge | null {
  const { edges, router } = routing;
  const matched = edges.filter((e) => {
    try { return e.guard(completion); } catch { return false; }
  });
  if (matched.length === 0) return null;

  switch (router.kind) {
    case "first-match":
      return matched[0] ?? null;
    case "priority-first":
      return [...matched].sort((a, b) => b.priority - a.priority)[0] ?? null;
    case "custom":
      return (router.fn(matched, completion, instance) as Edge | null) ?? null;
    case "agent-choice":
      throw new Error("agent-choice 未实现");
    default:
      return matched[0] ?? null;
  }
}
