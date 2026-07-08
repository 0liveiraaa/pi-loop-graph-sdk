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
import type { Entry, Graph } from "./type.js";

export type ExecuteGraph = (
  pi: ExtensionAPI,
  graph: Graph,
  trigger: { source: string; args?: string; params?: Record<string, unknown> },
) => Promise<void>;

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
    private readonly executeGraph: ExecuteGraph,
  ) {}

  /** 注册一张图。有 invocation 的图自动注册为 pi 命令 + 工具。 */
  registerGraph(graph: Graph): void {
    if (this.graphs.has(graph.id)) {
      throw new Error(`图 "${graph.id}" 已注册`);
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
        await this.executeGraph(this.pi, graph, { source: "command", args, params });
      },
    });

    // 注册 pi 工具（供 LLM tool-call）
    const pi = this.pi;
    const executeGraph = this.executeGraph;
    this.pi.registerTool({
      name: inv.name,
      label: inv.name,
      description: inv.description,
      parameters: inv.inputSchema as any,
      async execute(_toolCallId: any, params: any) {
        await executeGraph(pi, graph, {
          source: "tool",
          params: params as Record<string, unknown>,
        });
        return {
          content: [{ type: "text", text: `图 "${graph.id}" 执行完成` as string }],
          details: {} as Record<string, unknown>,
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
    _defaultRegistry = new GraphRegistry(pi, _defaultExecuteGraph);
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
