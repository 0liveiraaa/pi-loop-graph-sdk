// ============================================================
//  图注册表
// ============================================================
//
//  管理所有已注册的 Graph，将带 invocation 的图自动注册为
//  pi 命令 + pi 工具，不带 invocation 的图仅作为子图可用。
//
//  注册命令：/xxx → Trigger { source: "command", args }
//  注册工具：xxx  → Trigger { source: "tool", params }
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Graph, Trigger } from "../type.js";

/** 已注册的图及其元信息 */
export interface RegisteredGraph {
  graph: Graph;
  /** 图的调用契约（如果有） */
  invocation: NonNullable<Graph["invocation"]> | null;
}

export class GraphRegistry {
  private graphs = new Map<string, RegisteredGraph>();
  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** 注册一个图。有 invocation 的自动注册 pi 命令 + 工具 */
  register(graph: Graph): void {
    if (this.graphs.has(graph.id)) {
      throw new Error(`Graph "${graph.id}" 已注册`);
    }

    const registered: RegisteredGraph = {
      graph,
      invocation: graph.invocation ?? null,
    };

    this.graphs.set(graph.id, registered);

    // 有 invocation → 注册对外接口
    if (graph.invocation) {
      this.registerCommand(graph);
      this.registerAsTool(graph);
    }
  }

  /** 根据 ID 查找图 */
  get(id: string): Graph | undefined {
    return this.graphs.get(id)?.graph;
  }

  /** 根据 Trigger 查找匹配的图入口 */
  findEntry(
    trigger: Trigger,
    background: Record<string, unknown>,
  ): { graph: Graph; entryId: string; startNodeId: string } | null {
    for (const { graph } of this.graphs.values()) {
      for (const entry of graph.entries) {
        try {
          if (entry.guard(background)) {
            return {
              graph,
              entryId: entry.id,
              startNodeId: entry.startNodeId,
            };
          }
        } catch {
          // guard 可能因 background 格式不对而抛异常，跳过
          continue;
        }
      }
    }
    return null;
  }

  /** 获取所有已注册图的数量 */
  get size(): number {
    return this.graphs.size;
  }

  // ── 私有：pi 命令/工具注册 ──────────────────────────

  private registerCommand(graph: Graph): void {
    const inv = graph.invocation!;
    this.pi.registerCommand(inv.name, {
      description: inv.description,
      handler: async (args, ctx) => {
        // 命令处理由 Runtime 负责，这里只负责触发
        // 实际的图运行由 extension.ts 中的命令 handler 统一处理
        // 此 handler 作为 fallback：如果 extension.ts 的 handler 未拦截，
        // 则通知用户这个命令需要图运行支持
        ctx.ui.notify(
          `命令 /${inv.name} 需要一个活跃的 Loop Graph Runtime`,
          "warning",
        );
      },
    });
  }

  private registerAsTool(graph: Graph): void {
    const inv = graph.invocation!;
    this.pi.registerTool({
      name: inv.name,
      label: inv.name,
      description: inv.description,
      parameters: inv.inputSchema as any,
      async execute(_toolCallId, params) {
        // 工具调用也由 Runtime 负责
        // 这里返回占位结果，实际的图运行由 tool_call 事件拦截处理
        return {
          content: [
            {
              type: "text",
              text: `Graph "${inv.name}" triggered via tool call`,
            },
          ],
          details: { params },
        };
      },
    });
  }
}
