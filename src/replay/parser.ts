import type { ReplayDocument } from "./finalizer.js";
import type { ReplayEventEnvelope } from "./events.js";
import type { ReplayInvocationModel, ReplayModel } from "./model.js";

export function parseReplay(input: string | ReplayDocument): ReplayModel {
  const document = typeof input === "string" ? JSON.parse(input) as ReplayDocument : input;
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.events)) throw new TypeError("Unsupported replay document");
  const buckets = new Map<string, { parentId?: string; graphId?: string; graphVersion?: string; boundary?: string; events: ReplayEventEnvelope[] }>();
  const unscoped: ReplayEventEnvelope[] = [];
  const summary: Record<string, number> = {};
  for (const envelope of document.events) {
    summary[envelope.event.domain] = (summary[envelope.event.domain] ?? 0) + 1;
    if (!envelope.graphInvocationId) { unscoped.push(envelope); continue; }
    const bucket = buckets.get(envelope.graphInvocationId) ?? { events: [] };
    bucket.events.push(envelope);
    if (envelope.event.type === "graph_entered" && isObject(envelope.event.data)) {
      bucket.parentId = stringValue(envelope.event.data.parentGraphInvocationId);
      bucket.graphId = stringValue(envelope.event.data.graphId);
      bucket.graphVersion = stringValue(envelope.event.data.graphVersion);
      bucket.boundary = stringValue(envelope.event.data.boundary);
    }
    buckets.set(envelope.graphInvocationId, bucket);
  }
  const build = (id: string, stack = new Set<string>()): ReplayInvocationModel => {
    if (stack.has(id)) throw new TypeError("Replay invocation cycle");
    const bucket = buckets.get(id)!;
    const next = new Set(stack); next.add(id);
    const children = [...buckets].filter(([, value]) => value.parentId === id).map(([child]) => build(child, next));
    return Object.freeze({ id, ...bucket, events: Object.freeze(bucket.events), children: Object.freeze(children) });
  };
  for (const id of buckets.keys()) build(id);
  const roots = [...buckets].filter(([, value]) => !value.parentId || !buckets.has(value.parentId)).map(([id]) => build(id));
  if (buckets.size > 0 && roots.length === 0) throw new TypeError("Replay invocation cycle");
  return Object.freeze({
    schemaVersion: 1, rootRunId: document.rootRunId, mode: document.mode, createdAt: document.createdAt,
    recording: document.recording, result: document.result, ...(document.totalCost === undefined ? {} : { totalCost: document.totalCost }),
    summary: Object.freeze(summary), invocations: Object.freeze(roots), unscopedEvents: Object.freeze(unscoped),
  });
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
