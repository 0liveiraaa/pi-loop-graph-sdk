import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { defineGraph } from "../../src/builders/graph.js";
import { codeNode } from "../../src/builders/node.js";
import { entry, finish, firstMatch } from "../../src/builders/route.js";
import { createGraphHost } from "../../src/host/graph-host.js";
import { RuntimeEventBus } from "../../src/runtime/event-bus.js";
import { finalizeJournal } from "../../src/replay/finalizer.js";
import { Recorder } from "../../src/replay/recorder.js";
import { FileRunStore, type RunStore } from "../../src/replay/store.js";
import type { ReplayArtifactRef } from "../../src/replay/events.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const Value = Type.Object({ value: Type.Number() });
const graph = defineGraph({
  id: "phase8", version: "1", goal: "record", input: Value, output: Value,
  context: { background: { select: "none" } },
  entries: [entry("main", { to: "work" })],
  stages: {
    work: {
      node: codeNode({ subGoal: "echo", input: Value, output: Value, execute: ({ input }) => input }),
      route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
    },
  },
});

describe("Phase 8 recorder and RunStore", () => {
  it("records ordered Runtime facts and finalizes a versioned replay document", async () => {
    const root = await tempRoot();
    const store = new FileRunStore(root);
    const host = createGraphHost({ runStore: store });
    const result = await host.execute(graph, { value: 7 });

    expect(result).toMatchObject({ status: "completed", replay: { mode: "replay", status: "complete" } });
    const document = JSON.parse(await store.readReplay(result.rootRunId));
    expect(document).toMatchObject({ schemaVersion: 1, rootRunId: result.rootRunId, recording: { status: "complete" } });
    expect(document.result.replay.status).toBe("complete");
    expect(document.events.map((item: any) => item.sequence)).toEqual(
      Array.from({ length: document.events.length }, (_, index) => index + 1),
    );
    expect(document.events.map((item: any) => item.event.type)).toEqual(expect.arrayContaining([
      "root_started", "graph_entered", "node_entered", "transition_selected", "root_finished", "recording_finalizing",
    ]));
    await host.dispose();
  });

  it("off mode performs no persistence", async () => {
    const store = memoryStore();
    const host = createGraphHost({ runStore: store, recording: "off" });
    const result = await host.execute(graph, { value: 1 });
    expect(result.replay).toEqual({ mode: "off", status: "off" });
    expect(store.appendJournal).not.toHaveBeenCalled();
  });

  it("redacts credentials and hidden reasoning unless forensic mode is explicit", async () => {
    const replayStore = memoryStore();
    const replayRecorder = new Recorder({ mode: "replay", store: replayStore });
    replayRecorder.record({ domain: "model", type: "model_turn_finished", data: {
      provider: "test", model: "m", token: "private", reasoning: "hidden", answer: "visible",
    } }, { rootRunId: "run-replay" });
    await replayRecorder.finalize(fakeResult("run-replay"));
    const replayLine = JSON.parse(replayStore.journal.get("run-replay")!.split("\n")[0]);
    expect(replayLine.event.data).toEqual({ provider: "test", model: "m", token: "[REDACTED]", answer: "visible" });

    const forensicStore = memoryStore();
    const forensicRecorder = new Recorder({ mode: "forensic", store: forensicStore });
    forensicRecorder.record({ domain: "model", type: "model_turn_finished", data: { token: "private", reasoning: "hidden" } }, { rootRunId: "run-forensic" });
    await forensicRecorder.finalize(fakeResult("run-forensic"));
    expect(JSON.parse(forensicStore.journal.get("run-forensic")!.split("\n")[0]).event.data).toEqual({ token: "private", reasoning: "hidden" });
  });

  it("moves large payloads to artifacts and reports a missing artifact", async () => {
    const store = memoryStore();
    const recorder = new Recorder({ mode: "replay", store, artifactThresholdBytes: 16 });
    recorder.record({ domain: "context", type: "context_snapshot", data: { text: "x".repeat(100) } }, { rootRunId: "artifact-run" });
    const finalized = await recorder.finalize(fakeResult("artifact-run"));
    expect(finalized.replay.status).toBe("complete");
    const first = JSON.parse(store.journal.get("artifact-run")!.split("\n")[0]);
    expect(first.event.data).toMatchObject({ artifactId: expect.any(String), byteSize: expect.any(Number) });

    store.artifacts.clear();
    const document = await finalizeJournal({ store, runId: "artifact-run", mode: "replay", result: fakeResult("artifact-run") });
    expect(document.recording.status).toBe("incomplete");
    expect(document.recording.issues.join(" ")).toContain("artifact");
  });

  it("keeps complete JSONL entries when the final journal line is partial", async () => {
    const store = memoryStore();
    store.journal.set("partial", `${JSON.stringify(envelope(1, "partial"))}\n{"schemaVersion":1`);
    const document = await finalizeJournal({ store, runId: "partial", mode: "events", result: fakeResult("partial") });
    expect(document.events).toHaveLength(1);
    expect(document.recording).toMatchObject({ status: "incomplete", issues: ["invalid journal line 2"] });
  });

  it("isolates persistence failure by default and upgrades it when required", async () => {
    const failing = memoryStore();
    failing.appendJournal.mockRejectedValue(new Error("disk full"));

    const bestEffort = createGraphHost({ runStore: failing });
    await expect(bestEffort.execute(graph, { value: 1 })).resolves.toMatchObject({
      status: "completed", replay: { status: "failed", issues: expect.arrayContaining([expect.stringContaining("disk full")]) },
    });

    const required = createGraphHost({ runStore: failing, recordingRequired: true });
    await expect(required.execute(graph, { value: 2 })).resolves.toMatchObject({
      status: "failed", failure: { code: "persistence-failed", phase: "host" }, replay: { status: "failed" },
    });
  });

  it("uses PricingResolver for model usage without hard-coded prices", async () => {
    const store = memoryStore();
    const pricing = vi.fn(() => 0.25);
    const recorder = new Recorder({ mode: "events", store, pricingResolver: pricing });
    recorder.record({ domain: "model", type: "model_turn_finished", data: {
      provider: "provider", model: "model", turn: 1, retry: 0, durationMs: 12,
      usage: { inputTokens: 10, outputTokens: 5 },
    } }, { rootRunId: "priced" });
    await recorder.finalize(fakeResult("priced"));
    const document = JSON.parse(store.replays.get("priced")!);
    expect(pricing).toHaveBeenCalledWith({ provider: "provider", model: "model", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(document.totalCost).toBe(0.25);
  });

  it("FileRunStore confines identifiers and atomically stores artifacts/checkpoints", async () => {
    const root = await tempRoot();
    const store = new FileRunStore(root);
    const artifact = await store.writeArtifact("run-1", "payload.json", "{\"ok\":true}");
    expect(await store.readArtifact("run-1", artifact.artifactId)).toBe("{\"ok\":true}");
    await store.writeCheckpoint("run-1", "node.json", "{\"next\":1}");
    expect(await store.readCheckpoint("run-1", "node.json")).toBe("{\"next\":1}");
    await expect(store.appendJournal("../escape", "{}" )).rejects.toThrow(/unsafe path/);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "loop-graph-phase8-"));
  temporaryRoots.push(root);
  return root;
}

function fakeResult(rootRunId: string): any {
  return { rootRunId, graphId: "g", graphVersion: "1", steps: 0, durationMs: 0, status: "completed", output: {}, replay: { mode: "off", status: "off" } };
}

function envelope(sequence: number, rootRunId: string): any {
  return { schemaVersion: 1, sequence, timestamp: new Date(0).toISOString(), rootRunId, event: { domain: "root", type: "root_started" } };
}

function memoryStore(): RunStore & {
  journal: Map<string, string>;
  artifacts: Map<string, string>;
  replays: Map<string, string>;
  appendJournal: ReturnType<typeof vi.fn>;
} {
  const journal = new Map<string, string>();
  const artifacts = new Map<string, string>();
  const replays = new Map<string, string>();
  return {
    journal, artifacts, replays,
    appendJournal: vi.fn(async (runId: string, line: string) => {
      journal.set(runId, `${journal.get(runId) ?? ""}${line}\n`);
    }),
    readJournal: vi.fn(async (runId: string) => {
      const value = journal.get(runId);
      if (value === undefined) throw new Error("journal missing");
      return value;
    }),
    writeArtifact: vi.fn(async (_runId: string, artifactId: string, content: string): Promise<ReplayArtifactRef> => {
      artifacts.set(artifactId, content);
      return { artifactId, mediaType: "application/json", byteSize: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    }),
    readArtifact: vi.fn(async (_runId: string, artifactId: string) => {
      const value = artifacts.get(artifactId);
      if (value === undefined) throw new Error("artifact missing");
      return value;
    }),
    writeCheckpoint: vi.fn(async () => undefined),
    readCheckpoint: vi.fn(async () => "{}"),
    writeReplay: vi.fn(async (runId: string, content: string) => { replays.set(runId, content); }),
    readReplay: vi.fn(async (runId: string) => replays.get(runId) ?? ""),
    location: vi.fn((runId: string) => `memory://${runId}`),
  };
}
