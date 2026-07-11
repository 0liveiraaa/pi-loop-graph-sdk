// ============================================================
//  图注册表 — 实例级图注册与命令/工具注册
// ============================================================
//
//  GraphRegistry 为每个 LoopGraphExtension 实例持有独立 graph map，
//  不同业务 extension 创建的 registry 不互相污染。
//
//  保留全局兼容导出 registerGraph / initRegistry / findEntry，
//  内部委托到默认实例。标注 @deprecated，推荐使用
//  createLoopGraphExtension() 创建实例级 registry。
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateGraphTools } from "./validate.js";
import type { Entry, Graph, GraphRunResult } from "./type.js";
import type { GraphInvoker } from "./adapter/graph-execution-host.js";

export type ExecuteGraph = (
  pi: ExtensionAPI,
  graph: Graph,
  trigger: { source: string; args?: string; params?: Record<string, unknown> },
) => Promise<GraphRunResult>;

export interface GraphRegistryOptions {
  /** graph tool 返回给模型的最大 UTF-8 字节数。默认 16 KiB。 */
  toolResultMaxBytes?: number;
}

/**
 * 实例级图注册表。
 *
 * 每个 LoopGraphExtension 实例持有一个 GraphRegistry。
 * 命令 handler 调用注入的 executeGraph 执行图。
 */
export class GraphRegistry {
  private readonly graphs = new Map<string, Graph>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly invoker: GraphInvoker,
    private readonly options: GraphRegistryOptions = {},
  ) {}

  /** 注册一张图。有 invocation 的图自动注册为 pi 命令 + 工具。
   *
   * @param defaultTools 全局默认工具列表，用于校验节点工具配置。 */
  registerGraph(graph: Graph, defaultTools: string[] = []): void {
    if (this.graphs.has(graph.id)) {
      throw new Error(`图 "${graph.id}" 已注册`);
    }

    // 注册期校验：节点内工具重复
    const toolIssues = validateGraphTools(graph, defaultTools);
    if (toolIssues.length > 0) {
      throw new Error(
        `图 "${graph.id}" 工具校验失败:\n` +
          toolIssues.map((i) => `  ${i.path}: ${i.message}`).join("\n"),
      );
    }

    this.graphs.set(graph.id, graph);

    const inv = graph.invocation;
    if (!inv) return;

    // 注册 pi 命令：/xxx
    this.pi.registerCommand(inv.name, {
      description: inv.description,
      handler: async (args, ctx) => {
        const params = inv.parseArgs ? inv.parseArgs(args) : { args };
        ctx.ui.notify(`启动图: ${graph.id}`, "info");
        const result = await this.invoker.invoke(graph, {
          background: params,
          invocationKind: "command",
          boundary: "delegate",
          signal: ctx.signal,
        }, ctx);
        ctx.ui.notify(
          result.status === "ok"
            ? `图完成: ${graph.id}（${result.steps} 步）`
            : `图结束: ${graph.id}（${result.status}）`,
          result.status === "ok" ? "info" : "warning",
        );
      },
    });

    // 注册 pi 工具（供 LLM tool-call）
    const invoker = this.invoker;
    const maxBytes = this.options.toolResultMaxBytes;
    this.pi.registerTool({
      name: inv.name,
      label: inv.name,
      description: inv.description,
      parameters: inv.inputSchema as any,
      async execute(_toolCallId: any, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
        const result = await invoker.invoke(graph, {
          background: params as Record<string, unknown>,
          invocationKind: "tool",
          boundary: "delegate",
          signal: signal ?? ctx?.signal,
        }, ctx);
        return {
          content: [{ type: "text", text: encodeGraphToolResult(result, maxBytes) }],
          details: result,
        };
      },
    } as any);
  }

  /** 根据 background 查找匹配的图入口。 */
  findEntry(
    background: Record<string, unknown>,
  ): { graph: Graph; entry: Entry; startNodeId: string } | null {
    for (const graph of this.graphs.values()) {
      for (const entry of graph.entries) {
        try {
          if (entry.guard(background)) {
            return { graph, entry, startNodeId: entry.startNodeId };
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  /** 获取已注册图的数量（测试用）。 */
  get size(): number {
    return this.graphs.size;
  }

  /** 检查某图是否已注册（测试用）。 */
  has(graphId: string): boolean {
    return this.graphs.has(graphId);
  }
}

/** 对模型可见的结果始终是有效 JSON；过大时只保留有界 preview。 */
export function encodeGraphToolResult(
  result: GraphRunResult,
  maxBytes = 16 * 1024,
): string {
  const full = JSON.stringify(result);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;

  const minimum = JSON.stringify({ truncated: true });
  if (maxBytes <= Buffer.byteLength(minimum, "utf8")) return minimum;

  let low = 0;
  let high = full.length;
  let best = minimum;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      graphId: result.graphId,
      status: result.status,
      steps: result.steps,
      truncated: true,
      preview: full.slice(0, mid),
    });
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

// ── @deprecated 全局兼容层 ──────────────────────────────────
//
//  以下导出保留向后兼容，委托到默认实例。
//  新代码应使用 createLoopGraphExtension()。

let _defaultRegistry: GraphRegistry | null = null;
let _defaultExecuteGraph: ExecuteGraph | null = null;

/**
 * @deprecated 使用 createLoopGraphExtension(pi).registerGraph(graph)
 */
export function initRegistry(
  executeGraph: ExecuteGraph,
): void {
  _defaultExecuteGraph = executeGraph;
}

/**
 * @deprecated 使用 createLoopGraphExtension(pi).registerGraph(graph)
 */
export function registerGraph(pi: ExtensionAPI, graph: Graph): void {
  if (!_defaultRegistry) {
    if (!_defaultExecuteGraph) {
      throw new Error("loop-graph Registry 尚未初始化。请使用 createLoopGraphExtension(pi) 创建实例。");
    }
    const executeGraph = _defaultExecuteGraph;
    _defaultRegistry = new GraphRegistry(pi, {
      invoke(target, request) {
        return executeGraph(pi, target, {
          source: request.invocationKind === "command" ? "command" : "tool",
          params: request.background,
        });
      },
    });
  }
  _defaultRegistry.registerGraph(graph);
}

/**
 * @deprecated 使用 createLoopGraphExtension(pi) 创建实例后调用 registry.findEntry()
 */
export function findEntry(
  background: Record<string, unknown>,
): { graph: Graph; entry: Entry; startNodeId: string } | null {
  return _defaultRegistry?.findEntry(background) ?? null;
}
