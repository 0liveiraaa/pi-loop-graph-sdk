// ============================================================
//  图注册表（公开 API）
// ============================================================
//
//  `registerGraph` 是 Loop Graph 的公开入口。
//  loop-graph extension 自己用它注册内置测试图，
//  用户 extension 用它注册自己的业务图。
//
//  所有图共享同一套 Runtime（executeGraph），
//  由 extension.ts 在初始化时注入。
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Entry, Graph } from "./type.js";

const graphs = new Map<string, Graph>();

/** Runtime 主循环函数引用，由 extension.ts 初始化时注入 */
let _executeGraph: ((
  pi: ExtensionAPI,
  graph: Graph,
  trigger: { source: string; args?: string; params?: Record<string, unknown> },
) => Promise<void>) | null = null;

/**
 * 由 loop-graph extension 初始化时调用一次，
 * 把 Runtime 主循环注入注册表，供命令/tool handler 使用。
 */
export function initRegistry(
  executeGraph: NonNullable<typeof _executeGraph>,
): void {
  _executeGraph = executeGraph;
}

/**
 * 注册一个图。有 invocation 的图自动注册为 pi 命令 + 工具。
 * loop-graph extension 和用户 extension 都可以调用。
 */
export function registerGraph(pi: ExtensionAPI, graph: Graph): void {
  if (graphs.has(graph.id)) {
    throw new Error(`图 "${graph.id}" 已注册`);
  }

  graphs.set(graph.id, graph);

  const inv = graph.invocation;
  if (!inv) return;

  // 注册 pi 命令：/xxx
  pi.registerCommand(inv.name, {
    description: inv.description,
    handler: async (args, ctx) => {
      if (!_executeGraph) throw new Error("loop-graph Registry 尚未初始化");
      ctx.ui.notify(`启动图: ${graph.id}`, "info");
      await _executeGraph(pi, graph, { source: "command", args });
    },
  });

  // 注册 pi 工具（供 LLM tool-call）
  pi.registerTool({
    name: inv.name,
    label: inv.name,
    description: inv.description,
    parameters: inv.inputSchema as any,
    async execute(_toolCallId: any, params: any) {
      if (!_executeGraph) throw new Error("loop-graph Registry 尚未初始化");
      await _executeGraph(pi, graph, {
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

/**
 * 根据 trigger + background 查找匹配的图入口。
 * 遍历所有已注册图，逐个调用 Entry.guard。
 */
export function findEntry(
  background: Record<string, unknown>,
): { graph: Graph; entry: Entry; startNodeId: string } | null {
  for (const graph of graphs.values()) {
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
