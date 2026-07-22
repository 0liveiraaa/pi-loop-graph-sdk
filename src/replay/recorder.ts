import type { GraphRunResult, ReplayReference } from "../core/result.js";
import type { JsonValue } from "../core/json.js";
import type { RuntimeEvent, RuntimeEventBus } from "../runtime/event-bus.js";
import { finalizeJournal } from "./finalizer.js";
import { REPLAY_SCHEMA_VERSION, type PricingResolver, type RecordingMode, type ReplayEvent, type ReplayEventEnvelope, type ReplayEventScope } from "./events.js";
import type { RunStore } from "./store.js";

export interface RecorderOptions {
  readonly mode: Exclude<RecordingMode, "off">;
  readonly store: RunStore;
  readonly artifactThresholdBytes?: number;
  readonly pricingResolver?: PricingResolver;
  readonly now?: () => Date;
}

export class Recorder {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly issues: string[] = [];
  private rootRunId: string | undefined;
  private unsubscribe?: () => void;

  constructor(private readonly options: RecorderOptions) {}

  attach(eventBus: RuntimeEventBus): void {
    this.unsubscribe?.();
    this.unsubscribe = eventBus.subscribe((event) => this.recordRuntimeEvent(event));
  }

  record(event: ReplayEvent, scope: ReplayEventScope): void {
    this.rootRunId ??= scope.rootRunId;
    const envelope: ReplayEventEnvelope = Object.freeze({
      schemaVersion: REPLAY_SCHEMA_VERSION,
      sequence: ++this.sequence,
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      ...scope,
      event: Object.freeze({
        ...event,
        ...(event.data === undefined ? {} : { data: toRecordedJson(event.data, this.options.mode) }),
      }),
    });
    this.queue = this.queue.then(() => this.persist(envelope)).catch((error) => {
      this.issues.push(errorMessage(error));
    });
  }

  async finalize<T>(result: GraphRunResult<T>): Promise<{ readonly replay: ReplayReference; readonly documentWritten: boolean }> {
    if (this.rootRunId) {
      this.record({ domain: "recording", type: "recording_finalizing" }, { rootRunId: this.rootRunId });
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.queue;
    const runId = this.rootRunId ?? result.rootRunId;
    try {
      const recordedResult = toRecordedJson(result, this.options.mode) as unknown as GraphRunResult;
      const serializedResult = JSON.stringify(recordedResult);
      const threshold = this.options.artifactThresholdBytes ?? 64 * 1024;
      const persistedResult = Buffer.byteLength(serializedResult, "utf8") > threshold
        ? await this.options.store.writeArtifact(runId, "final-result.json", serializedResult)
        : recordedResult;
      const document = await finalizeJournal({
        store: this.options.store,
        runId,
        mode: this.options.mode,
        result: persistedResult,
        pricingResolver: this.options.pricingResolver,
        initialIssues: this.issues,
      });
      const status = document.recording.status;
      const replay = Object.freeze({
        mode: this.options.mode,
        status,
        location: this.options.store.location(runId),
        issues: document.recording.issues,
      }) satisfies ReplayReference;
      const replayResult = isArtifactReference(persistedResult)
        ? persistedResult
        : { ...recordedResult, replay };
      await this.options.store.writeReplay(runId, `${JSON.stringify({ ...document, result: replayResult }, null, 2)}\n`);
      return {
        replay,
        documentWritten: true,
      };
    } catch (error) {
      const issues = Object.freeze([...this.issues, errorMessage(error)]);
      return {
        replay: Object.freeze({
          mode: this.options.mode,
          status: "failed",
          location: this.options.store.location(runId),
          issues,
        }),
        documentWritten: false,
      };
    }
  }

  private recordRuntimeEvent(event: RuntimeEvent): void {
    const { rootRunId, graphInvocationId, nodeVisitId, agentRunId, ...data } = event as RuntimeEvent & ReplayEventScope;
    this.record({ domain: runtimeDomain(event.type), type: event.type, data: toRecordedJson(data, this.options.mode) }, {
      rootRunId,
      graphInvocationId,
      nodeVisitId,
      agentRunId,
    });
    if (event.type === "root_started" && this.options.mode === "forensic") {
      this.record({
        domain: "recording",
        type: "forensic_recording_warning",
        data: { message: "Forensic recording may contain unredacted sensitive data and hidden reasoning." },
      }, { rootRunId });
    }
  }

  private async persist(envelope: ReplayEventEnvelope): Promise<void> {
    const threshold = this.options.artifactThresholdBytes ?? 64 * 1024;
    const serializedData = envelope.event.data === undefined ? undefined : JSON.stringify(envelope.event.data);
    let persisted = envelope;
    if (serializedData && Buffer.byteLength(serializedData, "utf8") > threshold) {
      const artifactId = `${String(envelope.sequence).padStart(8, "0")}-${safeType(envelope.event.type)}.json`;
      const artifact = await this.options.store.writeArtifact(envelope.rootRunId, artifactId, serializedData);
      persisted = Object.freeze({ ...envelope, event: Object.freeze({ ...envelope.event, data: artifact }) });
    }
    await this.options.store.appendJournal(envelope.rootRunId, JSON.stringify(persisted));
  }
}

export function toRecordedJson(value: unknown, mode: RecordingMode): JsonValue {
  return sanitize(value, mode, new WeakSet<object>()) as JsonValue;
}

function sanitize(value: unknown, mode: RecordingMode, ancestors: WeakSet<object>, key = ""): JsonValue {
  if (mode !== "forensic" && sensitiveKey(key)) return "[REDACTED]";
  if (mode !== "forensic" && key === "thinking") return "[REDACTED]";
  if (mode === "events" && verboseKey(key)) return "[OMITTED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return mode === "forensic" ? value : redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === undefined) return String(value);
  if (ancestors.has(value as object)) return "[CIRCULAR]";
  if (mode !== "forensic" && isThinkingBlock(value)) {
    return { type: "thinking", thinking: "[REDACTED]" };
  }
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, mode, ancestors));
    const output: Record<string, JsonValue> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (mode !== "forensic" && (childKey === "reasoning" || childKey === "thinking")) continue;
      output[childKey] = sanitize(child, mode, ancestors, childKey);
    }
    return output;
  } catch {
    return String(value);
  } finally {
    ancestors.delete(value as object);
  }
}

function isThinkingBlock(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "thinking";
}

function sensitiveKey(key: string): boolean {
  return /^(authorization|api[-_]?key|token|password|secret|cookie|set-cookie)$/i.test(key);
}

function verboseKey(key: string): boolean {
  return /^(content|input|output|result|payload|reasoning|toolResults)$/i.test(key);
}

function redactString(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
}

function runtimeDomain(type: RuntimeEvent["type"]): ReplayEvent["domain"] {
  if (type.startsWith("root_") || type === "host_baseline_selected") return "root";
  if (type.startsWith("graph_")) return "graph";
  if (type.startsWith("node_")) return "node";
  if (type.startsWith("agent_")) return "agent";
  if (type.startsWith("context_")) return "context";
  if (type.startsWith("mechanism_") || type === "runtime_warning") return "mechanism";
  if (type.startsWith("transition_")) return "transition";
  return "recording";
}

function safeType(type: string): string {
  return type.replace(/[^A-Za-z0-9._-]/g, "_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isArtifactReference(value: unknown): value is import("./events.js").ReplayArtifactRef {
  return value !== null && typeof value === "object" && "artifactId" in value && "sha256" in value;
}
