// ============================================================
//  工具解析 — 全仓库单一真相源
// ============================================================
//
//  只有一个函数产出最终工具列表。setActiveTools 调它，
//  debug 日志也调它。
// ============================================================

export const FRAMEWORK_TOOLS = ["read", "__graph_complete__"] as const;

export interface ToolResolverInput {
  readonly defaultTools: readonly string[];
  readonly nodeTools: readonly string[];
  readonly frameworkTools: typeof FRAMEWORK_TOOLS;
  readonly graphId?: string;
  readonly nodeId?: string;
}

/** 返回候选工具；SDK 随后统一去重并恢复 framework tools 的首尾不变量。 */
export type ToolResolver = (input: ToolResolverInput) => readonly string[];

export const defaultToolResolver: ToolResolver = ({ defaultTools, nodeTools }) => [
  ...defaultTools,
  ...nodeTools,
];

/**
 * 计算节点的最终工具列表。
 *
 * 规则：
 *   [read, ...defaultTools, ...nodeTools, __graph_complete__]
 *   去重（保留首次出现的位置），read 始终在第一位，
 *   __graph_complete__ 始终在最后。
 */
export function resolveNodeTools(
  defaultTools: readonly string[],
  nodeTools: readonly string[],
  resolver: ToolResolver = defaultToolResolver,
  identity: Pick<ToolResolverInput, "graphId" | "nodeId"> = {},
): string[] {
  const resolved = resolver(Object.freeze({
    defaultTools: Object.freeze([...defaultTools]),
    nodeTools: Object.freeze([...nodeTools]),
    frameworkTools: FRAMEWORK_TOOLS,
    ...identity,
  }));
  if (!Array.isArray(resolved) || resolved.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new TypeError("toolResolver 必须返回非空工具名数组");
  }
  const merged = ["read", ...resolved, "__graph_complete__"];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of merged) {
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  // 确保 read 在首、__graph_complete__ 在尾
  const readIdx = result.indexOf("read");
  if (readIdx > 0) {
    result.splice(readIdx, 1);
    result.unshift("read");
  }
  const completeIdx = result.indexOf("__graph_complete__");
  if (completeIdx >= 0 && completeIdx !== result.length - 1) {
    result.splice(completeIdx, 1);
    result.push("__graph_complete__");
  }
  return result;
}
