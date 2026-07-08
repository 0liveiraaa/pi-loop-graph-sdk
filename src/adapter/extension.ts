// ============================================================
//  Loop Graph Extension — pi 入口
// ============================================================
//
//  这是 pi extension 的主入口文件。
//
//  初始化：创建 PiNodeContext，注册 __graph_complete__ 工具。
//  为每个带 invocation 的图自动注册 pi 命令。
//  命令 handler 内部使用 async/await + Promise 桥接驱动完整图运行。
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentInstance,
  Edge,
  Graph,
  Node,
  NodeCompletion,
  NodeInput,
  NodeRouting,
  Trigger,
} from "../type.js";
import { END } from "../type.js";
import { COMPLETE_TOOL_NAME, createCompleteTool } from "./complete-tool.js";
import { buildNodeEntryMessage } from "./node-entry.js";
import { PiNodeContext } from "./pi-node-context.js";
import { serializeInstance } from "./state-store.js";
import { normalizeTrigger } from "./trigger.js";

// ── 图导入（后续改为动态发现）───────────────────────────
import { reviewGraph } from "../graphs/review-graph.js";

// ═══════════════════════════════════════════════════════════

/** 活跃的图运行状态 */
interface ActiveRun {
  graph: Graph;
  instance: AgentInstance;
  currentNodeId: string;
  currentInput: NodeInput;
}

export default function loopGraphExtension(pi: ExtensionAPI) {
  // ── 初始化 ────────────────────────────────────────────

  const nodeContext = new PiNodeContext({ pi });

  pi.registerTool(createCompleteTool());

  // 监听 __graph_complete__ tool_result，传递给 PiNodeContext
  pi.on("tool_result", (event) => {
    if (event.toolName === COMPLETE_TOOL_NAME) {
      const params = event.details as {
        status: "ok" | "failed" | "cancelled";
        result: Record<string, unknown>;
      } | null;
      if (params) {
        nodeContext.recordCompletion(params);
      }
    }
  });

  // agent_end → 桥接到 PiNodeContext 的 Promise
  pi.on("agent_end", () => {
    nodeContext.onAgentEnd();
  });

  // ── 注册所有图 ────────────────────────────────────────

  registerGraph(pi, reviewGraph);

  // ═══════════════════════════════════════════════════════

  /** 顶层活跃运行（一次只允许一个） */
  let activeRun: ActiveRun | null = null;

  function registerGraph(_pi: ExtensionAPI, graph: Graph): void {
    const inv = graph.invocation;
    if (!inv) return;

    pi.registerCommand(inv.name, {
      description: inv.description,
      handler: async (args, ctx) => {
        if (activeRun) {
          ctx.ui.notify("已有活跃的图运行，请等待完成", "warning");
          return;
        }
        ctx.ui.notify(`启动图: ${graph.id}`, "info");
        await executeGraph(graph, { source: "command", args });
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolDef: any = {
      name: inv.name,
      label: inv.name,
      description: inv.description,
      parameters: inv.inputSchema,
      async execute(_toolCallId: any, params: any) {
        await executeGraph(graph, {
          source: "tool",
          params: params as Record<string, unknown>,
        });
        return {
          content: [{ type: "text", text: `图 "${graph.id}" 执行完成` as string }],
          details: {} as Record<string, unknown>,
        };
      },
    };
    pi.registerTool(toolDef);
  }

  // ═══════════════════════════════════════════════════════
  //  Runtime 主循环
  // ═══════════════════════════════════════════════════════

  async function executeGraph(
    graph: Graph,
    trigger: Trigger,
  ): Promise<void> {
    const background = normalizeTrigger(trigger, graph);

    const entry = graph.entries.find((e) => {
      try { return e.guard(background); } catch { return false; }
    });
    if (!entry) {
      pi.sendMessage({
        customType: "loop_graph_error",
        content: `无法匹配图入口：${JSON.stringify(background)}`,
        display: true,
      });
      return;
    }

    const instance: AgentInstance = {
      id: crypto.randomUUID(),
      globalGoal: graph.goal,
      background,
      frames: [],
      mechanisms: [],
    };

    let nodeId = entry.startNodeId;
    let input: NodeInput = {
      data: entry.mapInput ? entry.mapInput(background) : background,
      source: { kind: "entry", entryId: entry.id },
    };
    activeRun = { graph, instance, currentNodeId: nodeId, currentInput: input };

    try {
      const MAX_STEPS = 100;
      for (let step = 0; step < MAX_STEPS; step++) {
        const node = graph.nodes[nodeId];
        if (!node) throw new Error(`节点未找到: ${nodeId}`);

        applyNodeTools(pi, node);

        const completion = await executeNode(
          pi, nodeContext, instance, node, input,
        );

        const routing = graph.routing[nodeId];
        if (!routing) throw new Error(`节点 ${nodeId} 无路由配置`);

        const edge = selectEdge(routing, completion, instance);
        if (!edge) {
          throw new Error(
            `无边匹配节点 ${nodeId}: status=${completion.status}`,
          );
        }

        const migration = edge.migrate(instance, completion);
        instance.frames.push(migration.frame);

        persistState(pi, instance, graph, nodeId, input);

        if (edge.to === END) {
          pi.sendMessage({
            customType: "loop_graph_complete",
            content: `图 \`${graph.id}\` 完成（${step + 1} 步，${instance.frames.length} 帧）`,
            display: true,
          });
          break;
        }

        nodeId = edge.to;
        input = {
          data: migration.input ?? {},
          source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
        };
        activeRun.currentNodeId = nodeId;
        activeRun.currentInput = input;

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
      nodeContext.reset();
      activeRun = null;
      pi.setActiveTools(["read"]);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Compaction 防御
  // ═══════════════════════════════════════════════════════

  pi.on("session_compact", () => {
    if (!activeRun || activeRun.instance.frames.length === 0) return;
    const node = activeRun.graph.nodes[activeRun.currentNodeId];
    if (!node) return;

    const entryMsg = buildNodeEntryMessage(
      activeRun.instance,
      node,
      activeRun.currentInput,
    );
    pi.sendMessage({
      customType: "loop_graph_reinject",
      content: `[帧栈恢复]\n\n${entryMsg}`,
      display: false,
    });
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Loop Graph Extension 已加载", "info");
  });
}

// ── 辅助函数 ──────────────────────────────────────────────

async function executeNode(
  pi: ExtensionAPI,
  ctx: PiNodeContext,
  instance: AgentInstance,
  node: Node,
  input: NodeInput,
): Promise<NodeCompletion> {
  if (node.kind === "graph") {
    throw new Error(`复合节点未在 MVP 实现: ${node.id}`);
  }

  const isAgentNode = !!(node.skill || (node.tools && node.tools.length > 0));

  if (isAgentNode) {
    ctx.prepareNodeRun(instance, node, input);
    const prompt = buildAgentPrompt(instance, node, input);

    // 先注入节点进入消息
    const entryMsg = buildNodeEntryMessage(instance, node, input);
    pi.sendMessage({
      customType: "loop_graph_enter_node",
      content: entryMsg,
      display: true,
    });

    const result = await ctx.runAgent({ prompt, tools: node.tools, skill: node.skill });
    return {
      nodeId: node.id,
      status: (result.result?.status as "ok" | "failed" | "cancelled") ?? "ok",
      result: result.result ?? {},
    };
  }

  return node.execute(instance, input, ctx);
}

function applyNodeTools(pi: ExtensionAPI, node: Node): void {
  if (node.kind === "graph") return;
  const nodeTools = node.tools ?? [];
  pi.setActiveTools(["read", ...nodeTools, COMPLETE_TOOL_NAME]);
}

function buildAgentPrompt(
  instance: AgentInstance,
  node: Node,
  input: NodeInput,
): string {
  const parts: string[] = [];
  parts.push(`## 当前阶段: ${node.subGoal}`);
  parts.push("");
  parts.push(`全局目标: ${instance.globalGoal}`);
  parts.push("");
  if (instance.frames.length > 0) {
    parts.push("### 已完成的阶段");
    for (const f of instance.frames) {
      parts.push(`- ${f.nodeId}: ${f.summary}`);
    }
    parts.push("");
  }
  parts.push("### 当前输入");
  for (const [k, v] of Object.entries(input.data)) {
    parts.push(`- ${k}: ${JSON.stringify(v)}`);
  }
  parts.push("");
  parts.push(`请在完成本阶段工作后调用 \`${COMPLETE_TOOL_NAME}\` 工具提交结果。`);
  return parts.join("\n");
}

function selectEdge(
  routing: NodeRouting,
  completion: NodeCompletion,
  instance: AgentInstance,
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
      throw new Error("agent-choice router 未在 MVP 实现");
    default:
      return matched[0] ?? null;
  }
}

function persistState(
  pi: ExtensionAPI,
  instance: AgentInstance,
  graph: Graph,
  nodeId: string,
  input: NodeInput,
): void {
  pi.appendEntry(
    "loop_graph_instance",
    serializeInstance(instance, {
      activeGraphId: graph.id,
      currentNodeId: nodeId,
      currentNodeInput: input.data,
    }),
  );
}
