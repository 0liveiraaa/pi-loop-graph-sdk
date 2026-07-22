import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("Phase 0 characterization inventory", () => {
  it("keeps completion and output-contract characterization", () => {
    expect(read("tests/adapter/output-contract.test.ts")).toContain("output contract");
    expect(read("tests/adapter/pi-node-context.test.ts")).toContain("__graph_complete__");
  });

  it("keeps isolated Host characterization", () => {
    expect(read("tests/adapter/graph-execution-host.test.ts")).toContain("IsolatedSessionGraphHost");
    expect(read("tests/adapter/isolated-graph-session.test.ts")).toContain("createIsolatedGraphSessionFactory");
  });

  it("keeps call, compose, and delegate characterization", () => {
    const extensionTests = read("tests/adapter/loop-graph-extension.test.ts");
    expect(extensionTests).toMatch(/\bcall\b/);
    expect(extensionTests).toMatch(/\bcompose\b/);
    expect(extensionTests).toMatch(/\bdelegate\b/);
  });

  it("keeps compaction characterization", () => {
    expect(read("tests/adapter/compaction-frame.test.ts")).toContain("compaction");
    expect(read("tests/adapter/loop-graph-extension.test.ts")).toContain("session_before_compact");
  });

  it("keeps the packed consumer gate", () => {
    expect(existsSync(resolve(root, "tests/package-consumer/run.mjs"))).toBe(true);
  });
});
