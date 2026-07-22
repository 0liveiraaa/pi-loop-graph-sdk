import type { ExtractedAgentRun, ExtractedContextSnapshot, ExtractedNodeVisit, ExtractedTurn, ReplayModel } from "./model.js";

export function exportReplayHtml(model: ReplayModel): string {
  const header = renderHeader(model);
  const nodes = model.nodes.length > 0
    ? `<section><h2>🧠 What the Model Saw &amp; Did</h2>${model.nodes.map(n => renderNodeVisit(n)).join("")}</section>`
    : "";
  const timeline = `<section><h2>📊 Timeline</h2>${renderTimeline(model)}</section>`;
  const errors = renderErrors(model);
  const raw = `<section><details><summary><h2 style="display:inline">📋 Raw Events (${model.summary ? Object.values(model.summary).reduce((a,b) => a+b, 0) : 0} total)</h2></summary>
    <details><summary>Result</summary><pre>${escapeHtml(JSON.stringify(model.result, null, 2))}</pre></details>
    ${renderInvocations(model.invocations)}${renderEvents("Root events", model.unscopedEvents)}</details></section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Loop Graph Replay · ${escapeHtml(model.rootRunId.substring(0, 8))}</title><style>${CSS}</style></head><body>${header}${nodes}${errors}${timeline}${raw}</body></html>`;
}

function renderHeader(model: ReplayModel): string {
  const result = model.result;
  const isObj = result && typeof result === "object" && !Array.isArray(result);
  const raw = result as unknown as Record<string, unknown> | undefined;
  const status = isObj && "status" in (raw ?? {}) ? String(raw!.status) : "";
  const statusClass = status === "completed" ? "ok" : status === "failed" ? "fail" : status === "cancelled" ? "cancel" : "";
  const durationMs = isObj && "durationMs" in (raw ?? {}) ? Number(raw!.durationMs) : 0;
  const steps = isObj && "steps" in (raw ?? {}) ? Number(raw!.steps) : 0;
  const recordingStatus = model.recording.status;
  const cost = model.totalCost != null ? `$${model.totalCost.toFixed(4)}` : "";

  return `<header>
    <div class="hb"><h1>Loop Graph Replay</h1><span class="badge ${statusClass}">${escapeHtml(status)}</span></div>
    <div class="meta">
      <span>Run <code>${escapeHtml(model.rootRunId.substring(0, 8))}</code></span>
      <span>${formatMs(durationMs)}</span>
      <span>${steps} steps</span>
      ${cost ? `<span>${cost}</span>` : ""}
      <span class="rec-${recordingStatus}">recording: ${escapeHtml(recordingStatus)}</span>
    </div>
    <div class="meta"><span>Mode: ${escapeHtml(model.mode)}</span><span>Created: ${escapeHtml(model.createdAt)}</span></div>
  </header>`;
}

function renderNodeVisit(nv: ExtractedNodeVisit): string {
  const duration = nv.exitedAt ? ` · ${formatMs(Date.parse(nv.exitedAt) - Date.parse(nv.enteredAt))}` : "";
  return `<div class="node-card">
    <div class="node-head">
      <span class="node-stage">${escapeHtml(nv.stageId || nv.nodeVisitId.substring(0, 8))}</span>
      <span class="node-meta">entered ${formatTime(nv.enteredAt)}${duration}</span>
    </div>
    ${nv.agentRuns.map(ar => renderAgentRun(ar)).join("")}
  </div>`;
}

function renderAgentRun(ar: ExtractedAgentRun): string {
  const ctx = ar.contextSnapshot;
  const completionBadge = ar.completion
    ? `<span class="badge ${ar.completion.outcome === "accepted" ? "ok" : ar.completion.outcome === "rejected" ? "warn" : "fail"}">${ar.completion.outcome}</span>`
    : "";

  return `<div class="ar-card">
    <div class="ar-head">
      <span>🤖 Agent Run <code>${escapeHtml(ar.agentRunId.substring(0, 8))}</code></span>
      ${completionBadge}
    </div>
    ${ctx ? renderContext(ctx) : ""}
    ${ar.turns.map(t => renderTurn(t, ar.completion)).join("")}
    ${ar.completion ? renderCompletionVerdict(ar.completion) : ""}
  </div>`;
}

function renderContext(ctx: ExtractedContextSnapshot): string {
  return `<details class="ctx" open>
    <summary>📥 Context — what the model saw</summary>
    <div class="ctx-blocks">${ctx.blocks.map(b =>
      `<pre class="ctx-block">${escapeHtml(b.text)}</pre>`
    ).join("")}</div>
  </details>`;
}

function renderTurn(turn: ExtractedTurn, completion: ExtractedAgentRun["completion"]): string {
  const toolsHtml = turn.toolCalls.length > 0
    ? `<div class="tools">${turn.toolCalls.map(tc => renderToolCall(tc, completion)).join("")}</div>`
    : "";
  const textsHtml = turn.assistantTexts.length > 0
    ? turn.assistantTexts.map(t => `<div class="asstext">${escapeHtml(t)}</div>`).join("")
    : "";

  const meta = [
    turn.provider ? `${turn.provider}/${turn.model}` : "",
    turn.durationMs != null ? formatMs(turn.durationMs) : "",
    turn.usage?.inputTokens != null ? `↑${turn.usage.inputTokens}` : "",
    turn.usage?.outputTokens != null ? `↓${turn.usage.outputTokens}` : "",
  ].filter(Boolean).join(" · ");

  return `<div class="turn">
    <div class="turn-head">Turn ${turn.turnIndex} ${meta ? `<span class="turn-meta">${meta}</span>` : ""}</div>
    ${textsHtml}
    ${toolsHtml}
  </div>`;
}

function renderToolCall(tc: import("./model.js").ExtractedToolCall, completion: ExtractedAgentRun["completion"]): string {
  const isCompletion = tc.toolName === "__graph_complete__";
  const icon = tc.isError ? "❌" : isCompletion ? "✅" : "🔧";
  const cls = tc.isError ? "tool-err" : isCompletion ? "tool-comp" : "";

  const outcomeNote = isCompletion && completion
    ? ` → <span class="badge ${completion.outcome === "accepted" ? "ok" : completion.outcome === "rejected" ? "warn" : "fail"}">${completion.outcome}</span>${completion.reason ? ` <span class="reason">${escapeHtml(completion.reason)}</span>` : ""}`
    : "";

  const argsSummary = tc.args ? summarizeValue(tc.args) : "";
  const resultSummary = tc.result ? summarizeResult(tc.result) : "";

  return `<details class="tool ${cls}">
    <summary>${icon} <code>${escapeHtml(tc.toolName)}</code>${argsSummary ? `(${argsSummary})` : ""}${outcomeNote}</summary>
    ${tc.args ? `<div class="tool-detail"><b>Args</b><pre>${escapeHtml(JSON.stringify(tc.args, null, 2))}</pre></div>` : ""}
    ${tc.result ? `<div class="tool-detail"><b>Result</b><pre class="${tc.isError ? "err" : ""}">${escapeHtml(JSON.stringify(tc.result, null, 2))}</pre></div>` : ""}
  </details>`;
}

function renderCompletionVerdict(completion: import("./model.js").ExtractedCompletionAttempt): string {
  if (!completion) return "";
  const verdictIcon = completion.outcome === "accepted" ? "✅" : completion.outcome === "rejected" ? "🔄" : "❌";
  const stages = completion.validationStages.length > 0
    ? `<div class="val-chain">${completion.validationStages.map(s => `<span class="val-stage">→ ${escapeHtml(s)}</span>`).join("")}</div>`
    : "";
  return `<div class="completion-verdict ${completion.outcome}">
    ${verdictIcon} Completion <b>${escapeHtml(completion.outcome)}</b>
    ${completion.durationMs != null ? ` · ${formatMs(completion.durationMs)}` : ""}
    ${stages}
  </div>`;
}

function renderTimeline(model: ReplayModel): string {
  const events = allEvents(model);
  if (events.length === 0) return "<p>No events recorded.</p>";

  const items = events.map(ev => {
    const icon = domainIcon(ev.event.domain);
    const label = ev.event.type;
    const ts = formatTime(ev.timestamp);
    const scope = [ev.graphInvocationId, ev.nodeVisitId, ev.agentRunId]
      .filter(Boolean)
      .map(id => String(id).substring(0, 8))
      .join("/");
    const dataSummary = ev.event.data ? summarizeValue(ev.event.data, 100) : "";
    return `<div class="tl-item">
      <span class="tl-ts">${ts}</span>
      <span class="tl-icon">${icon}</span>
      <span class="tl-type">${escapeHtml(label)}</span>
      ${scope ? `<span class="tl-scope">${escapeHtml(scope)}</span>` : ""}
      ${dataSummary ? `<span class="tl-data">${escapeHtml(dataSummary)}</span>` : ""}
    </div>`;
  });

  return `<div class="timeline">${items.join("")}</div>`;
}

function renderErrors(model: ReplayModel): string {
  const issues = model.recording.issues ?? [];
  if (issues.length === 0) return "";
  return `<section class="errors"><h2>⚠️ Recording Issues</h2><ul>${issues.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul></section>`;
}

function renderInvocations(invocations: readonly import("./model.js").ReplayInvocationModel[]): string {
  return invocations.map(inv => {
    const label = `${inv.graphId ?? "Graph"} · ${inv.boundary ?? "unknown"}`;
    return `<details><summary>📦 ${escapeHtml(label)} <code>${escapeHtml(inv.id.substring(0, 8))}</code></summary>${renderEvents("Events", inv.events)}${inv.children.length > 0 ? renderInvocations(inv.children) : ""}</details>`;
  }).join("");
}

function renderEvents(title: string, events: readonly import("./events.js").ReplayEventEnvelope[]): string {
  if (events.length === 0) return "";
  return `<details><summary>${escapeHtml(title)} (${events.length})</summary><ol class="raw-events">${events.map(ev =>
    `<li><b>${escapeHtml(ev.event.type)}</b> <small>${escapeHtml(ev.timestamp)}</small><pre>${escapeHtml(JSON.stringify(ev.event.data ?? {}, null, 2))}</pre></li>`
  ).join("")}</ol></details>`;
}

// ── helpers ──

function allEvents(model: ReplayModel): readonly import("./events.js").ReplayEventEnvelope[] {
  const collect = (invs: readonly import("./model.js").ReplayInvocationModel[]): import("./events.js").ReplayEventEnvelope[] =>
    invs.flatMap(inv => [...inv.events, ...collect(inv.children)]);
  return [...model.unscopedEvents, ...collect(model.invocations)].sort((a, b) => a.sequence - b.sequence);
}

function domainIcon(d: string): string {
  const icons: Record<string, string> = { root: "🏠", graph: "📊", node: "📍", agent: "🤖", model: "💬", tool: "🔧", completion: "✅", mechanism: "⚙️", context: "📥", compaction: "🗜️", transition: "➡️", checkpoint: "💾", recording: "📝" };
  return icons[d] ?? "•";
}

function summarizeValue(value: unknown, maxLen = 60): string {
  if (typeof value === "string") return value.length > maxLen ? value.substring(0, maxLen) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    const kv = keys.slice(0, 3).map(k => `${k}=${summarizeValue((value as Record<string, unknown>)[k], 20)}`).join(", ");
    return `{${kv}${keys.length > 3 ? ", …" : ""}}`;
  }
  return "";
}

function summarizeResult(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    // Extract decision/reason fields for completion results
    const parts: string[] = [];
    if ("decision" in obj) parts.push(`decision=${obj.decision}`);
    if ("reason" in obj) parts.push(`reason="${String(obj.reason).substring(0, 80)}"`);
    if (parts.length > 0) return parts.join(", ");
    return `{${Object.keys(obj).length} keys}`;
  }
  return summarizeValue(value);
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });
  } catch { return iso; }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const CSS = `
body{font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1100px;margin:auto;padding:24px;color:#1a1a2e;background:#fafbfc}
header{border-bottom:2px solid #e2e8f0;padding-bottom:16px;margin-bottom:24px}
h1{font-size:1.5rem;margin:0}.hb{display:flex;align-items:center;gap:12px;margin-bottom:8px}
h2{font-size:1.15rem;margin:24px 0 12px;color:#334155}
.meta{display:flex;gap:20px;flex-wrap:wrap;font-size:.85rem;color:#64748b;margin-top:4px}
.meta code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:.8rem}
.badge{padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:600;text-transform:uppercase}
.badge.ok{background:#dcfce7;color:#166534}.badge.fail{background:#fee2e2;color:#991b1b}
.badge.warn{background:#fef3c7;color:#92400e}.badge.cancel{background:#f1f5f9;color:#475569}
.rec-complete{color:#166534}.rec-incomplete,.rec-failed{color:#991b1b}
.node-card{border:1px solid #e2e8f0;border-radius:10px;margin:12px 0;overflow:hidden}
.node-head{background:#f8fafc;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0}
.node-stage{font-weight:700;font-size:1.05rem}
.node-meta{font-size:.8rem;color:#64748b}
.ar-card{margin:0;padding:12px 16px;border-top:1px solid #f1f5f9}
.ar-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-weight:600}
details.ctx{margin:8px 0;padding:8px 12px;background:#f0f9ff;border-radius:8px;border:1px solid #bae6fd}
details.ctx summary{color:#0369a1;cursor:pointer;font-weight:600}
.ctx-blocks{margin-top:8px}
.ctx-block{background:#fff;border:1px solid #e0f2fe;padding:10px;border-radius:6px;margin:6px 0;white-space:pre-wrap;font-size:.82rem;max-height:18rem;overflow:auto}
.turn{margin:8px 0 8px 20px;padding:8px 12px;background:#fff;border:1px solid #f1f5f9;border-radius:8px}
.turn-head{font-size:.85rem;color:#475569;margin-bottom:4px;font-weight:600}
.turn-meta{font-weight:400;font-size:.78rem;color:#94a3b8}
.asstext{margin:0 0 6px 0;font-size:.85rem;line-height:1.6;white-space:pre-wrap;color:#1e293b}
.tools{margin-top:6px}
details.tool{margin:4px 0;padding:4px 8px;border-radius:6px;font-size:.83rem}
details.tool summary{cursor:pointer}
details.tool-comp{background:#f0fdf4;border:1px solid #bbf7d0}
details.tool-err{background:#fef2f2;border:1px solid #fecaca}
details.tool summary code{background:#e2e8f0;padding:1px 5px;border-radius:3px;font-size:.8rem}
.tool-detail{margin-top:4px}.tool-detail pre{white-space:pre-wrap;max-height:16rem;overflow:auto;background:#f8fafc;padding:8px;border-radius:4px;font-size:.78rem;margin:2px 0}
.tool-detail pre.err{background:#fef2f2}
.reason{font-size:.8rem;color:#991b1b;margin-left:8px}
.completion-verdict{padding:8px 12px;margin:8px 0 0 12px;border-radius:6px;font-size:.85rem}
.completion-verdict.accepted{background:#f0fdf4;border:1px solid #bbf7d0}
.completion-verdict.rejected{background:#fef3c7;border:1px solid #fde68a}
.completion-verdict.failed{background:#fef2f2;border:1px solid #fecaca}
.val-chain{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:.78rem}
.val-stage{background:#f1f5f9;padding:2px 6px;border-radius:4px;color:#64748b}
.timeline{font-size:.82rem;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
.tl-item{display:flex;align-items:baseline;gap:8px;padding:4px 12px;border-bottom:1px solid #f8fafc;flex-wrap:wrap}
.tl-item:hover{background:#f8fafc}
.tl-ts{font-family:monospace;font-size:.75rem;color:#94a3b8;min-width:6rem}
.tl-icon{min-width:1.2rem;text-align:center}
.tl-type{font-weight:600;min-width:10rem;font-size:.8rem}
.tl-scope{font-family:monospace;font-size:.7rem;color:#94a3b8}
.tl-data{font-size:.75rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;max-width:30rem}
.errors{background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:.85rem;color:#991b1b}
.errors ul{margin:4px 0 0;padding-left:20px}
.raw-events{font-size:.78rem;padding:0;list-style:none}
.raw-events li{padding:4px 8px;border-bottom:1px solid #f1f5f9}
.raw-events pre{white-space:pre-wrap;max-height:12rem;overflow:auto;background:#f8fafc;padding:6px;border-radius:4px;font-size:.72rem;margin:2px 0}
summary{cursor:pointer}
details>summary h2{display:inline;margin:0}
pre{margin:0;word-break:break-word}
code{word-break:break-all}
` as const;
