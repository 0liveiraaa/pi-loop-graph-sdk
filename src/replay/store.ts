import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, appendFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ReplayArtifactRef } from "./events.js";

export interface JournalStore {
  appendJournal(runId: string, line: string): Promise<void>;
  readJournal(runId: string): Promise<string>;
}

export interface ArtifactStore {
  writeArtifact(runId: string, artifactId: string, content: string, mediaType?: string): Promise<ReplayArtifactRef>;
  readArtifact(runId: string, artifactId: string): Promise<string>;
}

export interface CheckpointStore {
  writeCheckpoint(runId: string, checkpointId: string, content: string): Promise<void>;
  readCheckpoint(runId: string, checkpointId: string): Promise<string>;
  listCheckpoints?(runId: string): Promise<readonly string[]>;
  pruneCheckpoints?(runId: string, keep: readonly string[]): Promise<void>;
  deleteCheckpoint?(runId: string, checkpointId: string): Promise<void>;
}

export interface RunStore extends JournalStore, ArtifactStore, CheckpointStore {
  writeReplay(runId: string, content: string): Promise<void>;
  readReplay(runId: string): Promise<string>;
  location(runId: string): string | undefined;
}

export interface FileRunStoreOptions {
  readonly rootDir?: string;
}

export class FileRunStore implements RunStore {
  readonly rootDir: string;

  constructor(options: FileRunStoreOptions | string = {}) {
    this.rootDir = resolve(typeof options === "string" ? options : (options.rootDir ?? ".loop-graph/runs"));
  }

  location(runId: string): string {
    return this.runDir(runId);
  }

  async appendJournal(runId: string, line: string): Promise<void> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "journal.jsonl"), line.endsWith("\n") ? line : `${line}\n`, "utf8");
  }

  readJournal(runId: string): Promise<string> {
    return readFile(join(this.runDir(runId), "journal.jsonl"), "utf8");
  }

  async writeArtifact(runId: string, artifactId: string, content: string, mediaType = "application/json"): Promise<ReplayArtifactRef> {
    const safeId = safeSegment(artifactId, "artifactId");
    const dir = join(this.runDir(runId), "artifacts");
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, safeId), content);
    return Object.freeze({
      artifactId: safeId,
      mediaType,
      byteSize: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  readArtifact(runId: string, artifactId: string): Promise<string> {
    return readFile(join(this.runDir(runId), "artifacts", safeSegment(artifactId, "artifactId")), "utf8");
  }

  async writeCheckpoint(runId: string, checkpointId: string, content: string): Promise<void> {
    const dir = join(this.runDir(runId), "checkpoints");
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, safeSegment(checkpointId, "checkpointId")), content);
  }

  readCheckpoint(runId: string, checkpointId: string): Promise<string> {
    return readFile(join(this.runDir(runId), "checkpoints", safeSegment(checkpointId, "checkpointId")), "utf8");
  }

  async listCheckpoints(runId: string): Promise<readonly string[]> {
    try {
      return Object.freeze((await readdir(join(this.runDir(runId), "checkpoints"), { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
  }

  async pruneCheckpoints(runId: string, keep: readonly string[]): Promise<void> {
    const retained = new Set(keep.map((id) => safeSegment(id, "checkpointId")));
    for (const id of await this.listCheckpoints(runId)) {
      if (!retained.has(id)) await this.deleteCheckpoint(runId, id);
    }
  }

  async deleteCheckpoint(runId: string, checkpointId: string): Promise<void> {
    await rm(join(this.runDir(runId), "checkpoints", safeSegment(checkpointId, "checkpointId")), { force: true });
  }

  async writeReplay(runId: string, content: string): Promise<void> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, "replay.json"), content);
  }

  readReplay(runId: string): Promise<string> {
    return readFile(join(this.runDir(runId), "replay.json"), "utf8");
  }

  private runDir(runId: string): string {
    return join(this.rootDir, safeSegment(runId, "runId"));
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function safeSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new TypeError(`${name} contains unsafe path characters`);
  }
  return value;
}
