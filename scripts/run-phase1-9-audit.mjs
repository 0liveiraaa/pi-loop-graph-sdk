import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createPiGraphHost } from "../dist/adapter/isolated-graph-session.js";
import { ToolCatalog } from "../dist/host/tool-catalog.js";
import { SkillCatalog } from "../dist/host/skill-catalog.js";
import { FileRunStore } from "../dist/replay/store.js";
import { parseReplay, exportReplayHtml } from "../dist/replay/index.js";
import { phaseAuditGraphs, phaseAuditRootGraph, phaseAuditSkillRegistration, PHASE_AUDIT_FAIL_TOOL } from "../dist/graphs/phase1-9-audit-graphs.js";

const cwd = resolve(process.cwd());
const outputRoot = resolve(process.env.PHASE_AUDIT_OUTPUT ?? join(cwd, ".loop-graph", "phase1-9-audit"));
await mkdir(outputRoot, { recursive: true });
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const requestedProvider = process.env.PI_MODEL_PROVIDER;
const requestedId = process.env.PI_MODEL_ID;
const model = requestedProvider && requestedId
  ? modelRegistry.find(requestedProvider, requestedId)
  : modelRegistry.getAvailable()[0];
if (!model) throw new Error("No authenticated model available. Set PI_MODEL_PROVIDER and PI_MODEL_ID after configuring Pi authentication.");

const tools = new ToolCatalog();
tools.register({ name: PHASE_AUDIT_FAIL_TOOL, description: "Always returns the expected audit failure", execute: async () => { throw new Error("PHASE_AUDIT_EXPECTED_TOOL_FAILURE"); } });
const skills = new SkillCatalog(); skills.register(phaseAuditSkillRegistration);
const store = new FileRunStore(outputRoot);
const host = await createPiGraphHost({ authStorage, modelRegistry, model, cwd, toolCatalog: tools, skillCatalog: skills, graphs: phaseAuditGraphs, runStore: store, recording: "replay" });
try {
  // The runtime-only extension catalog is per Session. Registering through the public
  // graph host currently resolves root and child refs from the injected catalog.
  const result = await host.execute(phaseAuditRootGraph, { publicTopic: "phase-1-9", secret: "PHASE_AUDIT_SECRET_MUST_NOT_APPEAR", marker: `AUDIT-${Date.now()}` }, { recording: "replay" });
  const replayPath = join(outputRoot, result.rootRunId, "replay.json");
  const replay = await readFile(replayPath, "utf8");
  const modelView = parseReplay(replay);
  const htmlPath = join(outputRoot, result.rootRunId, "report.html");
  await writeFile(htmlPath, exportReplayHtml(modelView), "utf8");
  const replayDocument = JSON.parse(replay);
  const events = replayDocument.events ?? [];
  const hasEvent = (domain, type, predicate = () => true) => events.some((entry) =>
    entry.event?.domain === domain && entry.event?.type === type && predicate(entry.event.data ?? {}, entry));
  const hasCompletionSubmission = (boundary, memoryMarkerVisible) => hasEvent("tool", "tool_execution_started", (data) =>
    data.toolName === "__graph_complete__"
    && data.args?.result?.boundary === boundary
    && data.args?.result?.memoryMarkerVisible === memoryMarkerVisible);
  const auditChecks = {
    runCompleted: result.status === "completed" && result.output?.phaseAudit === "passed",
    replayComplete: result.replay.status === "complete" && replayDocument.recording?.status === "complete",
    composeEntered: hasEvent("graph", "graph_entered", (data) => data.graphId === "phase_audit_compose" && data.boundary === "compose"),
    callEntered: hasEvent("graph", "graph_entered", (data) => data.graphId === "phase_audit_call" && data.boundary === "call"),
    composeMemoryVisible: hasCompletionSubmission("compose", true),
    callMemoryIsolated: hasCompletionSubmission("call", false),
    expectedToolFailureRecorded: hasEvent("tool", "tool_execution_finished", (data) => data.toolName === PHASE_AUDIT_FAIL_TOOL && data.isError === true),
    completionRejectedThenAccepted: hasEvent("completion", "completion.rejected", (data) => data.reason === "PHASE_AUDIT_EXPECTED_FIRST_REJECTION")
      && hasEvent("completion", "completion.accepted"),
    skillInstructionProjected: replay.includes("PHASE_AUDIT_SKILL_TOKEN"),
    secretNotRecorded: !replay.includes("PHASE_AUDIT_SECRET_MUST_NOT_APPEAR"),
  };
  const failedChecks = Object.entries(auditChecks).filter(([, passed]) => !passed).map(([name]) => name);
  process.stdout.write(`${JSON.stringify({ result, replayPath, htmlPath, registeredGraphs: phaseAuditGraphs.map((graph) => `${graph.id}@${graph.version}`), auditChecks, failedChecks }, null, 2)}\n`);
  if (failedChecks.length > 0) process.exitCode = 1;
} finally {
  await host.dispose();
}
