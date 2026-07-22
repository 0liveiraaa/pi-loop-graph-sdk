import type { ReplayDocument } from "./finalizer.js";
import type { ReplayEventEnvelope } from "./events.js";
import type {
  ExtractedAgentRun,
  ExtractedCompletionAttempt,
  ExtractedContextBlock,
  ExtractedContextSnapshot,
  ExtractedNodeVisit,
  ExtractedToolCall,
  ExtractedTurn,
  ReplayInvocationModel,
  ReplayModel,
} from "./model.js";

export function parseReplay(input: string | ReplayDocument): ReplayModel {
  const document = typeof input === "string" ? JSON.parse(input) as ReplayDocument : input;
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.events)) throw new TypeError("Unsupported replay document");

  // ── Bucket events by graphInvocationId ──
  const buckets = new Map<string, {
    parentId?: string; graphId?: string; graphVersion?: string; boundary?: string;
    events: ReplayEventEnvelope[];
  }>();
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

  // ── Build invocation tree ──
  const build = (id: string, stack = new Set<string>()): ReplayInvocationModel => {
    if (stack.has(id)) throw new TypeError("Replay invocation cycle");
    const bucket = buckets.get(id)!;
    const next = new Set(stack); next.add(id);
    const children = [...buckets].filter(([, v]) => v.parentId === id).map(([child]) => build(child, next));
    return Object.freeze({ id, ...bucket, events: Object.freeze(bucket.events), children: Object.freeze(children) });
  };
  for (const id of buckets.keys()) build(id);
  const roots = [...buckets].filter(([, v]) => !v.parentId || !buckets.has(v.parentId)).map(([id]) => build(id));
  if (buckets.size > 0 && roots.length === 0) throw new TypeError("Replay invocation cycle");

  // ── Structured extraction ──
  const allEvents = document.events as readonly ReplayEventEnvelope[];

  // Collect context snapshots
  const contextSnapshots: ExtractedContextSnapshot[] = [];
  for (const ev of allEvents) {
    if (ev.event.type !== "context_snapshot_projected") continue;
    const data = isObject(ev.event.data) ? ev.event.data : null;
    if (!data) continue;
    const message = data as Record<string, unknown>;
    const blocks: ExtractedContextBlock[] = [];
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isObject(block) && block.type === "text" && typeof block.text === "string") {
          blocks.push(Object.freeze({ text: block.text }));
        }
      }
    }
    if (blocks.length > 0) {
      contextSnapshots.push(Object.freeze({
        agentRunId: stringValue(ev.agentRunId) ?? "",
        nodeVisitId: stringValue(ev.nodeVisitId) ?? "",
        timestamp: ev.timestamp,
        blocks: Object.freeze(blocks),
      }));
    }
  }

  // Collect node visits
  const nodeVisits = new Map<string, ExtractedNodeVisit>();
  for (const ev of allEvents) {
    if (ev.event.type !== "node_entered") continue;
    const nvId = stringValue(ev.nodeVisitId);
    if (!nvId) continue;
    if (!nodeVisits.has(nvId)) {
      const data = isObject(ev.event.data) ? ev.event.data : null;
      nodeVisits.set(nvId, {
        nodeVisitId: nvId,
        stageId: stringValue(data?.stageId) ?? "",
        enteredAt: ev.timestamp,
        agentRuns: [],
      });
    }
  }
  for (const ev of allEvents) {
    if (ev.event.type !== "node_exited") continue;
    const nvId = stringValue(ev.nodeVisitId);
    if (!nvId) continue;
    const nv = nodeVisits.get(nvId);
    if (nv) nodeVisits.set(nvId, { ...nv, exitedAt: ev.timestamp });
  }

  // Collect agent runs
  const agentRuns = new Map<string, ExtractedAgentRun>();
  for (const ev of allEvents) {
    if (ev.event.type !== "agent_started") continue;
    const arId = stringValue(ev.agentRunId);
    if (!arId) continue;
    const data = isObject(ev.event.data) ? ev.event.data : null;
    const nvId = stringValue(ev.nodeVisitId) ?? "";
    if (!agentRuns.has(arId)) {
      // Determine stageId from enclosing node
      const nv = nodeVisits.get(nvId);
      agentRuns.set(arId, {
        agentRunId: arId,
        nodeVisitId: nvId,
        stageId: nv?.stageId ?? "",
        graphInvocationId: stringValue(ev.graphInvocationId) ?? "",
        turns: [],
        completions: [],
      });
    }
  }

  // Attach context snapshots to agent runs
  for (const cs of contextSnapshots) {
    const ar = agentRuns.get(cs.agentRunId);
    if (ar) agentRuns.set(ar.agentRunId, { ...ar, contextSnapshot: cs });
  }

  // Collect turns
  const turns = new Map<string, ExtractedTurn[]>(); // keyed by agentRunId
  let currentArId: string | null = null;
  let currentTurnIdx = -1;
  for (const ev of allEvents) {
    if (ev.event.type === "agent_started") {
      currentArId = stringValue(ev.agentRunId) ?? null;
      currentTurnIdx = -1;
      continue;
    }
    if (ev.event.type === "model_turn_started") {
      const data = isObject(ev.event.data) ? ev.event.data : null;
      currentTurnIdx = typeof data?.turn === "number" ? data.turn : currentTurnIdx + 1;
      if (!currentArId) continue;
      const list = turns.get(currentArId) ?? [];
      list.push({
        turnIndex: currentTurnIdx,
        startedSequence: ev.sequence,
        assistantTexts: [],
        toolCalls: [],
      });
      turns.set(currentArId, list);
      continue;
    }
    if (ev.event.type === "model_turn_finished") {
      const data = isObject(ev.event.data) ? ev.event.data : null;
      if (!currentArId) continue;
      const list = turns.get(currentArId) ?? [];
      const last = list[list.length - 1];
      if (!last) continue;
      const message = data?.message;
      if (isObject(message)) {
        const provider = stringValue(data!.provider);
        const model = stringValue(data!.model);
        const usage = isObject(data!.usage)
          ? Object.freeze({ inputTokens: numberValue(data!.usage.inputTokens), outputTokens: numberValue(data!.usage.outputTokens) })
          : undefined;
        const durationMs = typeof data!.durationMs === "number" ? data!.durationMs : undefined;
        const texts: string[] = [];
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (isObject(block) && block.type === "text" && typeof block.text === "string") {
              texts.push(block.text);
            }
          }
        }
        list[list.length - 1] = Object.freeze({
          ...last,
          provider, model, usage, durationMs,
          assistantTexts: Object.freeze(texts),
        });
        turns.set(currentArId, list);
      }
    }
  }

  // Collect tool calls (link by toolCallId)
  const toolCallsById = new Map<string, ExtractedToolCall>();
  const toolCallsByArId = new Map<string, ExtractedToolCall[]>();
  for (const ev of allEvents) {
    if (ev.event.type === "tool_execution_started" || ev.event.type === "tool_execution_finished") {
      const tcId = stringValue(ev.toolCallId);
      const arId = stringValue(ev.agentRunId);
      const data = isObject(ev.event.data) ? ev.event.data : null;
      if (!tcId) continue;
      const existing = toolCallsById.get(tcId);
      if (ev.event.type === "tool_execution_started") {
        const tc: ExtractedToolCall = {
          toolCallId: tcId,
          sequence: ev.sequence,
          toolName: stringValue(data?.toolName) ?? "unknown",
          args: data?.args,
          timestamp: ev.timestamp,
        };
        toolCallsById.set(tcId, tc);
        if (arId) {
          const list = toolCallsByArId.get(arId) ?? [];
          list.push(tc);
          toolCallsByArId.set(arId, list);
        }
      } else if (existing) {
        const updated: ExtractedToolCall = Object.freeze({
          ...existing,
          result: data?.result,
          isError: data?.isError === true,
        });
        toolCallsById.set(tcId, updated);
        if (arId) {
          const list = toolCallsByArId.get(arId) ?? [];
          const idx = list.findIndex(t => t.toolCallId === tcId);
          if (idx >= 0) list[idx] = updated;
        }
      }
    }
  }

  // Attach each tool call to the turn that was active when it started.
  for (const [arId, arTurns] of turns) {
    const tcList = toolCallsByArId.get(arId) ?? [];
    if (tcList.length > 0 && arTurns.length > 0) {
      const byTurn = arTurns.map((turn, index) => {
        const nextStart = arTurns[index + 1]?.startedSequence ?? Number.POSITIVE_INFINITY;
        const calls = tcList.filter((call) => call.sequence >= turn.startedSequence && call.sequence < nextStart);
        return calls.length > 0 ? Object.freeze({ ...turn, toolCalls: Object.freeze(calls) }) : turn;
      });
      turns.set(arId, byTurn);
      continue;
    }
  }

  // Collect completion attempts
  const completionsByArId = new Map<string, ExtractedCompletionAttempt[]>();
  const activeCompletionByArId = new Map<string, number>();
  const completionStagesByArId = new Map<string, string[]>();
  for (const ev of allEvents) {
    const arId = stringValue(ev.agentRunId);
    if (!arId) continue;
    if (ev.event.type === "completion.submitted") {
      const data = isObject(ev.event.data) ? ev.event.data : null;
      const attempts = completionsByArId.get(arId) ?? [];
      attempts.push({
        timestamp: ev.timestamp,
        schemaFingerprint: stringValue(data?.schemaFingerprint),
        outcome: "accepted", // default, will be updated
        validationStages: [],
      });
      completionsByArId.set(arId, attempts);
      activeCompletionByArId.set(arId, attempts.length - 1);
      completionStagesByArId.set(arId, []);
    }
    if (ev.event.type === "completion.validation_started") {
      const data = isObject(ev.event.data) ? ev.event.data : null;
      const stage = stringValue(data?.validatorStage);
      if (stage) {
        const stages = completionStagesByArId.get(arId) ?? [];
        stages.push(stage);
        completionStagesByArId.set(arId, stages);
      }
    }
    if (ev.event.type === "completion.accepted" || ev.event.type === "completion.rejected" || ev.event.type === "completion.failed") {
      const data = isObject(ev.event.data) ? ev.event.data : null;
      const outcome = ev.event.type === "completion.accepted" ? "accepted"
        : ev.event.type === "completion.failed" ? "failed" : "rejected";
      const attempts = completionsByArId.get(arId) ?? [];
      const activeIndex = activeCompletionByArId.get(arId);
      const stages = [...(completionStagesByArId.get(arId) ?? [])];
      const index = activeIndex ?? attempts.length;
      const existing = attempts[index];
      attempts[index] = Object.freeze({
        ...(existing ?? { timestamp: ev.timestamp, validationStages: Object.freeze(stages) }),
        outcome,
        reason: stringValue(data?.reason),
        validatorStage: stringValue(data?.validatorStage),
        durationMs: typeof data?.durationMs === "number" ? data.durationMs : undefined,
        validationStages: Object.freeze(stages),
      });
      completionsByArId.set(arId, attempts);
      activeCompletionByArId.delete(arId);
      completionStagesByArId.delete(arId);
    }
  }

  // Attach turns and completions to agent runs
  for (const [arId, ar] of agentRuns) {
    const arTurns = Object.freeze(turns.get(arId)?.map(t => Object.freeze(t)) ?? []);
    const completions = Object.freeze(completionsByArId.get(arId) ?? []);
    agentRuns.set(arId, Object.freeze({ ...ar, turns: arTurns, completions }));
  }

  // Attach agent runs to node visits
  for (const [, ar] of agentRuns) {
    const nv = nodeVisits.get(ar.nodeVisitId);
    if (nv) {
      nodeVisits.set(ar.nodeVisitId, Object.freeze({
        ...nv,
        agentRuns: Object.freeze([...nv.agentRuns, ar]),
      }));
    }
  }

  const nodes = Object.freeze([...nodeVisits.values()].map(nv =>
    Object.freeze({ ...nv, agentRuns: Object.freeze(nv.agentRuns) })
  ));

  return Object.freeze({
    schemaVersion: 1,
    rootRunId: document.rootRunId,
    mode: document.mode,
    createdAt: document.createdAt,
    recording: document.recording,
    result: document.result,
    ...(document.totalCost === undefined ? {} : { totalCost: document.totalCost }),
    summary: Object.freeze(summary),
    invocations: Object.freeze(roots),
    unscopedEvents: Object.freeze(unscoped),
    nodes,
    contextSnapshots: Object.freeze(contextSnapshots),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
