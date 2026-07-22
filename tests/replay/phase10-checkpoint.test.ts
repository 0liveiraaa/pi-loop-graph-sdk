import { describe, expect, it } from "vitest";
import { decodeCheckpoint, encodeCheckpoint } from "../../src/replay/checkpoint.js";
import { FileRunStore } from "../../src/replay/store.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const checkpoint = {
  kind: "node-boundary" as const, schemaVersion: 1 as const, checkpointId: "cp-1", rootRunId: "run-1",
  graph: { id: "g", version: "1" }, invocationStack: [{ graphInvocationId: "i-1", boundary: "root" as const, depth: 1 }],
  next: { stageId: "next", nodeInput: { value: 1 } }, frames: [{ done: true }], budget: { steps: 2 }, resumeAttempt: 0,
  mechanisms: [{ name: "m", snapshot: { state: 1 } }],
};

describe("Phase 10 checkpoint foundation", () => {
  it("round-trips a versioned node-boundary checkpoint and rejects incompatible schemas", () => {
    expect(decodeCheckpoint(encodeCheckpoint(checkpoint))).toEqual(checkpoint);
    expect(() => decodeCheckpoint(JSON.stringify({ ...checkpoint, schemaVersion: 2 }))).toThrow(/Unsupported checkpoint schema/);
    expect(() => decodeCheckpoint(JSON.stringify({ ...checkpoint, resumeAttempt: -1 }))).toThrow(/next boundary/);
  });

  it("lists, prunes, and deletes checkpoint files without affecting replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-graph-phase10-"));
    const store = new FileRunStore(root);
    await store.writeCheckpoint("run-1", "a", "{}");
    await store.writeCheckpoint("run-1", "b", "{}");
    expect(await store.listCheckpoints?.("run-1")).toEqual(["a", "b"]);
    await store.pruneCheckpoints?.("run-1", ["b"]);
    expect(await store.listCheckpoints?.("run-1")).toEqual(["b"]);
    await store.deleteCheckpoint?.("run-1", "b");
    expect(await store.listCheckpoints?.("run-1")).toEqual([]);
  });
});
