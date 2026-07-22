// ============================================================
//  图校验
// ============================================================

import type { Graph, GraphInvocationBoundary } from "./type.js";
import { END } from "./type.js";
import type { Graph as CoreGraph } from "./core/graph.js";
import { validateGraphDefinition } from "./core/graph.js";

export interface GraphValidationIssue {
  code:
    | "NO_ENTRY"
    | "ENTRY_TARGET_MISSING"
    | "ROUTING_NODE_MISSING"
    | "EDGE_FROM_MISMATCH"
    | "EDGE_TARGET_MISSING"
    | "NODE_ROUTING_MISSING"
    | "DUPLICATE_TOOL_IN_NODE"
    | "TOOL_NOT_REGISTERED"
    | "AGENT_CHOICE_EDGE_MISSING_DESCRIPTION"
    | "INVALID_BOUNDARY_FOLD"
    | "GRAPH_REFERENCE_CYCLE"
    | "UNSUPPORTED_GRAPH_BOUNDARY"
    | "DELEGATE_HOST_UNAVAILABLE";
  message: string;
  path: string;
}

export interface GraphValidationOptions {
  /** 当前执行载体已实现的 graph-node 边界。省略时只做结构校验。 */
  supportedBoundaries?: readonly GraphInvocationBoundary[];
  /** 当前注册/执行环境是否声明了 delegate host。 */
  delegateHostAvailable?: boolean;
}

export function validateGraph(
  graph: Graph | CoreGraph,
  options: GraphValidationOptions = {},
): GraphValidationIssue[] {
  if ("stages" in graph) {
    try {
      validateGraphDefinition(graph);
      return [];
    } catch (error) {
      return [{
        code: "ENTRY_TARGET_MISSING",
        message: error instanceof Error ? error.message : String(error),
        path: "graph",
      }];
    }
  }
  const issues: GraphValidationIssue[] = [];

  detectGraphReferenceCycles(graph, issues);
  validateGraphInvocationBoundaries(graph, options, issues);

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

    // agent-choice 路由：边 description 必填校验
    const isAgentChoice = routing.router.kind === "agent-choice";

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

      // agent-choice 路由下每条边必须有非空 description
      if (isAgentChoice && (!edge.description || edge.description.trim().length === 0)) {
        issues.push({
          code: "AGENT_CHOICE_EDGE_MISSING_DESCRIPTION",
          message: `节点 "${nodeId}" 使用 agent-choice 路由，边 "${edge.id}" 缺少 description。请为每条边声明可读描述，供 agent 决策时参考。`,
          path: `routing.${nodeId}.edges[${edge.id}].description`,
        });
      }
    }

  }

  return issues;
}

export function assertValidGraph(
  graph: Graph | CoreGraph,
  options: GraphValidationOptions = {},
): void {
  const issues = validateGraph(graph, options);
  if (issues.length > 0) {
    throw new Error(
      issues.map((i) => `${i.path}: ${i.message}`).join("\n"),
    );
  }
}

function detectGraphReferenceCycles(
  root: Graph,
  issues: GraphValidationIssue[],
): void {
  const ancestors = new Set<Graph>();

  const visit = (graph: Graph, path: string): void => {
    ancestors.add(graph);
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      if (node.kind !== "graph") continue;
      const childPath = `${path}.nodes.${nodeId}.graph`;
      if (ancestors.has(node.graph)) {
        issues.push({
          code: "GRAPH_REFERENCE_CYCLE",
          message: `检测到嵌套 Graph 循环引用: "${graph.id}" → "${node.graph.id}"。`,
          path: childPath,
        });
        continue;
      }
      visit(node.graph, childPath);
    }
    ancestors.delete(graph);
  };

  visit(root, `graph.${root.id}`);
}

function validateGraphInvocationBoundaries(
  root: Graph,
  options: GraphValidationOptions,
  issues: GraphValidationIssue[],
): void {
  const visited = new Set<Graph>();

  const visit = (graph: Graph, path: string): void => {
    if (visited.has(graph)) return;
    visited.add(graph);
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      if (node.kind !== "graph") continue;
      const nodePath = `${path}.nodes.${nodeId}`;
      const boundary = node.boundary ?? "call";

      if ((boundary === "call" || boundary === "delegate") && node.fold) {
        issues.push({
          code: "INVALID_BOUNDARY_FOLD",
          message: `graph 节点 "${nodeId}" 的 boundary 为 "${boundary}"，不能配置 fold。fold 仅对 compose 边界有效。`,
          path: `${nodePath}.boundary`,
        });
      }

      if (options.supportedBoundaries && !options.supportedBoundaries.includes(boundary)) {
        issues.push({
          code: "UNSUPPORTED_GRAPH_BOUNDARY",
          message: `graph 节点 "${nodeId}" 使用尚未由当前执行载体支持的 boundary: "${boundary}"。`,
          path: `${nodePath}.boundary`,
        });
      } else if (boundary === "delegate" && options.delegateHostAvailable === false) {
        issues.push({
          code: "DELEGATE_HOST_UNAVAILABLE",
          message: `graph 节点 "${nodeId}" 使用 delegate，但当前环境未提供 delegate host。`,
          path: `${nodePath}.boundary`,
        });
      }

      visit(node.graph, `${nodePath}.graph`);
    }
  };

  visit(root, `graph.${root.id}`);
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
  resolveTools?: (nodeId: string, nodeTools: readonly string[]) => readonly string[],
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
      const allTools = new Set(resolveTools
        ? resolveTools(nodeId, nodeTools)
        : ["read", "__graph_complete__", ...defaultTools, ...nodeTools]);
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
