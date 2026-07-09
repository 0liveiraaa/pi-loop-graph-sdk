// ============================================================
//  图校验
// ============================================================

import type { Graph } from "./type.js";
import { END } from "./type.js";

export interface GraphValidationIssue {
  code:
    | "NO_ENTRY"
    | "ENTRY_TARGET_MISSING"
    | "ROUTING_NODE_MISSING"
    | "EDGE_FROM_MISMATCH"
    | "EDGE_TARGET_MISSING"
    | "NODE_ROUTING_MISSING"
    | "DUPLICATE_TOOL_IN_NODE"
    | "TOOL_NOT_REGISTERED";
  message: string;
  path: string;
}

export function validateGraph(graph: Graph): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];

  // 必须有入口
  if (!graph.entries || graph.entries.length === 0) {
    issues.push({
      code: "NO_ENTRY",
      message: "图没有任何 Entry",
      path: "entries",
    });
    return issues;
  }

  for (const entry of graph.entries) {
    if (!(entry.startNodeId in graph.nodes)) {
      issues.push({
        code: "ENTRY_TARGET_MISSING",
        message: `Entry "${entry.id}" 的 startNodeId "${entry.startNodeId}" 不存在`,
        path: `entries[${entry.id}]`,
      });
    }
  }

  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    // 每个节点必须有路由
    if (!(nodeId in graph.routing)) {
      issues.push({
        code: "NODE_ROUTING_MISSING",
        message: `节点 "${nodeId}" 没有路由配置`,
        path: `nodes.${nodeId}`,
      });
      continue;
    }

    const routing = graph.routing[nodeId];

    // 路由的 nodeId 必须一致
    if (routing.nodeId !== nodeId) {
      issues.push({
        code: "ROUTING_NODE_MISSING",
        message: `路由 nodeId "${routing.nodeId}" 与节点 "${nodeId}" 不匹配`,
        path: `routing.${nodeId}`,
      });
    }

    for (const edge of routing.edges) {
      // edge.from 必须等于 routing 的 nodeId
      if (edge.from !== nodeId) {
        issues.push({
          code: "EDGE_FROM_MISMATCH",
          message: `边 "${edge.id}" 的 from "${edge.from}" 与路由节点 "${nodeId}" 不匹配`,
          path: `routing.${nodeId}.edges[${edge.id}]`,
        });
      }

      // 非 END 边的 to 必须存在
      if (edge.to !== END && !(edge.to in graph.nodes)) {
        issues.push({
          code: "EDGE_TARGET_MISSING",
          message: `边 "${edge.id}" 的 to "${String(edge.to)}" 不存在`,
          path: `routing.${nodeId}.edges[${edge.id}]`,
        });
      }
    }
  }

  return issues;
}

export function assertValidGraph(graph: Graph): void {
  const issues = validateGraph(graph);
  if (issues.length > 0) {
    throw new Error(
      issues.map((i) => `${i.path}: ${i.message}`).join("\n"),
    );
  }
}

// ── 工具校验 ──

/**
 * 校验图中所有节点的工具配置。
 *
 * - 同一节点 tools 数组内有重复名 → 报错
 * - 如果提供 registeredNames，检查所有引用的工具是否已注册 → 报错
 *
 * defaultTools 与 node.tools 之间的重叠不做报错（那是故意注入），
 * 在 resolveNodeTools 中去重即可。
 */
export function validateGraphTools(
  graph: Graph,
  defaultTools: string[],
  registeredNames?: Set<string>,
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];

  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.kind !== "code") continue;

    const nodeTools = node.tools ?? [];

    // 节点内去重检查
    const seen = new Set<string>();
    for (const t of nodeTools) {
      if (seen.has(t)) {
        issues.push({
          code: "DUPLICATE_TOOL_IN_NODE",
          message: `节点 "${nodeId}" 的 tools 中有重复的工具名: "${t}"`,
          path: `nodes.${nodeId}.tools`,
        });
      }
      seen.add(t);
    }

    // 工具存在性检查
    if (registeredNames) {
      const allTools = new Set([
        "read",
        "__graph_complete__",
        ...defaultTools,
        ...nodeTools,
      ]);
      for (const t of allTools) {
        if (t === "read" || t === "__graph_complete__") continue;
        if (!registeredNames.has(t)) {
          issues.push({
            code: "TOOL_NOT_REGISTERED",
            message: `图 "${graph.id}" 节点 "${nodeId}" 引用了未注册的工具: "${t}"`,
            path: `nodes.${nodeId}.tools`,
          });
        }
      }
    }
  }

  return issues;
}
