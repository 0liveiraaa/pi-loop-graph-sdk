// ============================================================
//  工具解析 — 全仓库单一真相源
// ============================================================
//
//  只有一个函数产出最终工具列表。setActiveTools 调它，
//  debug 日志也调它。观测即真相。
// ============================================================

const FRAMEWORK_TOOLS = ["read", "__graph_complete__"];

/**
 * 计算节点的最终工具列表。
 *
 * 规则：
 *   [read, ...defaultTools, ...nodeTools, __graph_complete__]
 *   去重（保留首次出现的位置），read 始终在第一位，
 *   __graph_complete__ 始终在最后。
 */
export function resolveNodeTools(
  defaultTools: string[],
  nodeTools: string[],
): string[] {
  const merged = [...FRAMEWORK_TOOLS, ...defaultTools, ...nodeTools];
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
