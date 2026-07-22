import type { JsonValue } from "../core/json.js";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface CheckpointNodeBoundary {
  readonly kind: "node-boundary";
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly checkpointId: string;
  /** Monotonic wall-clock ordering metadata; checkpoint ids are opaque. */
  readonly createdAt?: string;
  readonly rootRunId: string;
  readonly graph: { readonly id: string; readonly version: string };
  readonly invocationStack: readonly {
    readonly graphInvocationId: string;
    readonly parentGraphInvocationId?: string;
    readonly boundary: "root" | "call" | "compose" | "delegate";
    readonly depth: number;
    readonly graph?: { readonly id: string; readonly version: string };
  }[];
  readonly next: {
    readonly stageId: string;
    readonly nodeInput: JsonValue;
    /** Stable identity for repeated attempts to resume this pending Node Visit. */
    readonly nodeVisitId?: string;
  };
  readonly frames: readonly JsonValue[];
  readonly budget: JsonValue;
  readonly resumeAttempt: number;
  readonly mechanisms: readonly { readonly name: string; readonly snapshot: JsonValue }[];
}

export type CheckpointDocument = CheckpointNodeBoundary;

export function encodeCheckpoint(checkpoint: CheckpointDocument): string {
  assertCheckpoint(checkpoint);
  return JSON.stringify(checkpoint);
}

export function decodeCheckpoint(content: string): CheckpointDocument {
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw new Error(`Invalid checkpoint JSON: ${error instanceof Error ? error.message : String(error)}`); }
  assertCheckpoint(value);
  return value;
}

function assertCheckpoint(value: unknown): asserts value is CheckpointDocument {
  if (!isRecord(value) || value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || value.kind !== "node-boundary") {
    throw new Error(`Unsupported checkpoint schema: expected node-boundary v${CHECKPOINT_SCHEMA_VERSION}`);
  }
  if (!isNonEmpty(value.checkpointId) || !isNonEmpty(value.rootRunId) || !isNonEmpty(value.graph?.id) || !isNonEmpty(value.graph?.version)) {
    throw new Error("Checkpoint identity is incomplete");
  }
  if (!Array.isArray(value.invocationStack) || value.invocationStack.length === 0 || !Array.isArray(value.frames) || !Array.isArray(value.mechanisms)) {
    throw new Error("Checkpoint collections are invalid");
  }
  if (!isRecord(value.next) || !isNonEmpty(value.next.stageId) || !Number.isInteger(value.resumeAttempt) || value.resumeAttempt < 0) {
    throw new Error("Checkpoint next boundary is invalid");
  }
  if (value.createdAt !== undefined && (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))) {
    throw new Error("Checkpoint createdAt is invalid");
  }
  for (const entry of value.invocationStack) {
    if (!isRecord(entry) || !isNonEmpty(entry.graphInvocationId) || !Number.isInteger(entry.depth) || entry.depth < 1
      || !["root", "call", "compose", "delegate"].includes(entry.boundary)) throw new Error("Checkpoint invocation stack is invalid");
  }
  if (!isJson(value.next.nodeInput) || !value.frames.every(isJson) || !isJson(value.budget)
    || !value.mechanisms.every((item: unknown) => isRecord(item) && isNonEmpty(item.name) && isJson(item.snapshot))) {
    throw new Error("Checkpoint payload is not JSON-compatible");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
