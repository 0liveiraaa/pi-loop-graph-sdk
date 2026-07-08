// ============================================================
//  Trigger 归一化
// ============================================================
//
//  将三种来源的 Trigger 统一归约为 background:
//    command  — 用户 /name args → parseArgs(args) → background
//    tool     — agent 工具调用，params 即 background
//    subgraph — 父图传来的 background 原样
//
//  归一化后，Entry.guard 只需关注 background 内容，
//  不关心来源是用户还是 agent。
// ============================================================

import type { Graph, Trigger } from "../type.js";

/**
 * 将 Trigger 归一化为 background。
 * 如果 Trigger 是 command 且图有 parseArgs，则用它解析；
 * 否则用默认逻辑。
 */
export function normalizeTrigger(
  trigger: Trigger,
  graph?: Graph,
): Record<string, unknown> {
  switch (trigger.source) {
    case "command": {
      // 优先用图的 parseArgs，否则把裸 args 打包
      if (graph?.invocation?.parseArgs) {
        try {
          return graph.invocation.parseArgs(trigger.args);
        } catch {
          // parseArgs 失败时回退为默认
          return { args: trigger.args };
        }
      }
      return { args: trigger.args };
    }

    case "tool":
      // agent 工具调用时 params 已经过 schema 校验
      return trigger.params;

    case "subgraph":
      // 子图调用时 background 来自父图节点
      return trigger.background;
  }
}
