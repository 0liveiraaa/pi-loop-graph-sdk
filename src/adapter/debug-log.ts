// ============================================================
//  Debug Logger — 记录每层的输入、输出、帧栈
// ============================================================
//
//  输出到项目根目录 loop-graph-debug.log（JSONL 格式）。
//  每条日志含 timestamp + type + data。
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInstance, ContextFrame, Node, NodeCompletion, NodeInput } from "../type.js";
import type { ProjectionInput, MessageEntry } from "./projection.js";

const LOG_PATH = path.resolve("loop-graph-debug.log");

let fileOpened = false;

function log(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  if (!fileOpened) {
    fs.writeFileSync(LOG_PATH, "", "utf-8");
    fileOpened = true;
  }
  fs.appendFileSync(LOG_PATH, line + "\n", "utf-8");
}

export const debugLog = {
  /** 图启动 */
  graphStart(graphId: string, trigger: unknown): void {
    log({ type: "graph_start", graphId, trigger });
  },

  /** 进入节点 */
  enterNode(
    depth: number,
    nodeId: string,
    marker: string,
    input: NodeInput,
    frames: ContextFrame[],
  ): void {
    log({
      type: "enter_node",
      depth,
      nodeId,
      marker,
      inputData: input.data,
      frameCount: frames.length,
      frameSummaries: frames.map((f) => f.summary),
    });
  },

  /** 退出节点（折叠帧） */
  exitNode(
    depth: number,
    nodeId: string,
    frame: ContextFrame,
    allFrames: ContextFrame[],
  ): void {
    log({
      type: "exit_node",
      depth,
      nodeId,
      pushedFrame: { nodeId: frame.nodeId, status: frame.status, summary: frame.summary },
      totalFrames: allFrames.length,
    });
  },

  /** context 钩子投影 */
  projection(input: ProjectionInput, output: MessageEntry[]): void {
    log({
      type: "projection",
      messageCount: input.messages.length,
      splitMarker: input.nodeMarker,
      splitFound: input.nodeMarker
        ? input.messages.some((m) => m.content === input.nodeMarker)
        : false,
      frameCount: input.frames.length,
      currentNode: input.currentNode?.id ?? null,
      frameMsgCount: output.filter(
        (m) => typeof m.content === "string" && (m.content as string).startsWith("=== COMPLETED"),
      ).length,
      currentMsgCount: output.filter(
        (m) => typeof m.content === "string" && (m.content as string).startsWith("=== CURRENT"),
      ).length,
      otherCount: output.filter(
        (m) => typeof m.content !== "string" || !(m.content as string).startsWith("==="),
      ).length,
      messageTypes: output.slice(0, 8).map((m) => m.customType ?? m.role ?? "?"),
    });
  },

  /** agent 完成（__graph_complete__ 被调用） */
  agentComplete(nodeId: string, completion: NodeCompletion): void {
    log({
      type: "agent_complete",
      nodeId,
      status: completion.status,
      resultKeys: Object.keys(completion.result),
    });
  },

  /** agent 未调用 __graph_complete__ 就结束 */
  agentIncomplete(nodeId: string): void {
    log({ type: "agent_incomplete", nodeId });
  },

  /** 完成验证不通过，触发重试 */
  agentRetry(nodeId: string, reason: string): void {
    log({ type: "agent_retry", nodeId, reason });
  },

  /** 图结束 */
  graphEnd(graphId: string, steps: number, frames: ContextFrame[]): void {
    log({
      type: "graph_end",
      graphId,
      steps,
      frameCount: frames.length,
      frameSummaries: frames.map((f) => ({ nodeId: f.nodeId, summary: f.summary })),
    });
  },

  /** 图错误 */
  graphError(graphId: string, error: string): void {
    log({ type: "graph_error", graphId, error });
  },

  /** 子图 push */
  subgraphPush(parentNodeId: string, childGraphId: string): void {
    log({ type: "subgraph_push", parentNodeId, childGraphId });
  },

  /** 子图 pop */
  subgraphPop(parentNodeId: string, childGraphId: string, result: unknown): void {
    log({ type: "subgraph_pop", parentNodeId, childGraphId, resultKeys: typeof result === "object" && result ? Object.keys(result as object) : [] });
  },

  /** 工具切换 */
  toolsChanged(nodeId: string, tools: string[]): void {
    log({ type: "tools_changed", nodeId, tools });
  },
};
