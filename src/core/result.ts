import type { JsonValue } from "./json.js";

export type GraphFailureCode =
  | "invalid-graph"
  | "invalid-input"
  | "entry-not-found"
  | "tool-unavailable"
  | "host-unavailable"
  | "agent-timeout"
  | "agent-ended-without-completion"
  | "validation-exhausted"
  | "max-steps-exceeded"
  | "no-route"
  | "transition-failed"
  | "mechanism-failed"
  | "persistence-failed"
  | "resume-incompatible"
  | "runtime-error"
  | "cancelled";

export type GraphFailurePhase =
  | "root"
  | "graph"
  | "entry"
  | "node"
  | "agent"
  | "route"
  | "transition"
  | "host";

export interface GraphFailure {
  readonly code: GraphFailureCode;
  readonly phase: GraphFailurePhase;
  readonly message: string;
  readonly retryable: boolean;
  readonly stageId?: string;
  readonly cause?: unknown;
}

export type RecordingMode = "off" | "events" | "replay" | "forensic";

export interface ReplayReference {
  readonly mode: RecordingMode;
  readonly status: "off" | "complete" | "incomplete" | "failed";
  readonly location?: string;
  readonly issues?: readonly string[];
}

export interface GraphRunCommon {
  readonly rootRunId: string;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly steps: number;
  readonly durationMs: number;
  readonly replay: ReplayReference;
}

export interface CompletedGraphRun<TOutput = JsonValue> extends GraphRunCommon {
  readonly status: "completed";
  readonly output: TOutput;
}

export interface FailedGraphRun extends GraphRunCommon {
  readonly status: "failed";
  readonly failure: GraphFailure;
}

export interface CancelledGraphRun extends GraphRunCommon {
  readonly status: "cancelled";
  readonly failure: GraphFailure & { readonly code: "cancelled" };
}

export type GraphRunResult<TOutput = JsonValue> =
  | CompletedGraphRun<TOutput>
  | FailedGraphRun
  | CancelledGraphRun;
