import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CompletionValidationStage,
  NodeCompletion,
} from "../type.js";

export interface AgentRunLifecycleContext {
  timestamp: number;
  graphRunId: string;
  graphId: string;
  nodeId: string;
  scopeId: string;
  agentRunId: number;
}

export type LoopGraphLifecycleEvent = Readonly<
  | { type: "graph_start"; timestamp: number; graphId: string; boundary: string; invocationKind: string }
  | { type: "graph_end"; timestamp: number; graphId: string; status: string; steps: number }
  | { type: "graph_error"; timestamp: number; graphId: string; error: string }
  | { type: "node_enter"; timestamp: number; graphId: string; nodeId: string; scopeId: string; depth: number }
  | { type: "node_exit"; timestamp: number; graphId: string; nodeId: string; scopeId: string; status: string; depth: number }
  | { type: "compaction"; timestamp: number; graphId: string; nodeId: string; scopeId: string; generation: number; reason?: unknown }
  | (AgentRunLifecycleContext & { type: "output_contract.prepared"; schemaFingerprint: string; schemaBytes: number })
  | (AgentRunLifecycleContext & { type: "completion.submitted"; schemaFingerprint?: string })
  | (AgentRunLifecycleContext & { type: "completion.validation_started"; validatorStage: CompletionValidationStage; schemaFingerprint?: string })
  | (AgentRunLifecycleContext & { type: "completion.accepted"; completionStatus: NodeCompletion["status"]; schemaFingerprint?: string; durationMs: number })
  | (AgentRunLifecycleContext & { type: "completion.rejected"; reason: string; validatorStage?: CompletionValidationStage; schemaFingerprint?: string; durationMs: number })
  | (AgentRunLifecycleContext & { type: "completion.failed"; scope: "node" | "graph"; reason: string; validatorStage?: CompletionValidationStage; schemaFingerprint?: string; durationMs: number })
>;

export type LoopGraphTraceSink = (
  event: LoopGraphLifecycleEvent,
) => void | Promise<void>;

export interface LoopGraphLogger {
  debug?(message: string, event?: LoopGraphLifecycleEvent): void;
  error?(message: string, event?: LoopGraphLifecycleEvent): void;
}

/** 观测失败不得改变图控制流。 */
export function emitLifecycleEvent(
  event: LoopGraphLifecycleEvent,
  traceSink?: LoopGraphTraceSink,
  logger?: LoopGraphLogger,
): void {
  try {
    const pending = traceSink?.(event);
    if (pending && typeof (pending as Promise<void>).catch === "function") {
      void (pending as Promise<void>).catch(() => {});
    }
  } catch {
    // observability is best-effort
  }
  try {
    const message = `[loop-graph] ${event.type}`;
    if (event.type === "graph_error") logger?.error?.(message, event);
    else logger?.debug?.(message, event);
  } catch {
    // logger failures are isolated from execution
  }
}

/** debug 模式使用的 JSONL sink；创建时不会清空已有文件。 */
export function createJsonlTraceSink(
  filePath = path.resolve("loop-graph-debug.log"),
): LoopGraphTraceSink {
  const resolved = path.resolve(filePath);
  return (event) => {
    fs.appendFileSync(resolved, `${JSON.stringify(event)}\n`, "utf8");
  };
}
