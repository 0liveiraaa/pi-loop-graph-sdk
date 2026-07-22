import type { ReplayDocument } from "./finalizer.js";
import type { ReplayEventEnvelope } from "./events.js";

export interface ReplayInvocationModel {
  readonly id: string;
  readonly parentId?: string;
  readonly graphId?: string;
  readonly graphVersion?: string;
  readonly boundary?: string;
  readonly events: readonly ReplayEventEnvelope[];
  readonly children: readonly ReplayInvocationModel[];
}

// ── Structured extraction (Post-parse enrichment) ──

export interface ExtractedContextBlock {
  readonly text: string;
}

export interface ExtractedContextSnapshot {
  readonly agentRunId: string;
  readonly nodeVisitId: string;
  readonly timestamp: string;
  readonly blocks: readonly ExtractedContextBlock[];
}

export interface ExtractedToolCall {
  readonly toolCallId: string;
  readonly sequence: number;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
  readonly timestamp: string;
}

export interface ExtractedTurn {
  readonly turnIndex: number;
  readonly startedSequence: number;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly durationMs?: number;
  readonly assistantTexts: readonly string[];
  readonly toolCalls: readonly ExtractedToolCall[];
}

export interface ExtractedCompletionAttempt {
  readonly timestamp: string;
  readonly schemaFingerprint?: string;
  readonly outcome: "accepted" | "rejected" | "failed";
  readonly reason?: string;
  readonly validatorStage?: string;
  readonly durationMs?: number;
  readonly validationStages: readonly string[];
}

export interface ExtractedAgentRun {
  readonly agentRunId: string;
  readonly nodeVisitId: string;
  readonly stageId: string;
  readonly graphInvocationId: string;
  readonly contextSnapshot?: ExtractedContextSnapshot;
  readonly turns: readonly ExtractedTurn[];
  readonly completions: readonly ExtractedCompletionAttempt[];
}

export interface ExtractedNodeVisit {
  readonly nodeVisitId: string;
  readonly stageId: string;
  readonly enteredAt: string;
  readonly exitedAt?: string;
  readonly agentRuns: readonly ExtractedAgentRun[];
}

export interface ReplayModel {
  readonly schemaVersion: 1;
  readonly rootRunId: string;
  readonly mode: ReplayDocument["mode"];
  readonly createdAt: string;
  readonly recording: ReplayDocument["recording"];
  readonly result: ReplayDocument["result"];
  readonly totalCost?: number;
  readonly summary: Readonly<Record<string, number>>;
  readonly invocations: readonly ReplayInvocationModel[];
  readonly unscopedEvents: readonly ReplayEventEnvelope[];
  // Structured enrichment (post-parse)
  readonly nodes: readonly ExtractedNodeVisit[];
  readonly contextSnapshots: readonly ExtractedContextSnapshot[];
}
