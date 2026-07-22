import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillRef } from "../../src/builders/refs.js";
import { SkillCatalog } from "../../src/host/skill-catalog.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SkillCatalog", () => {
  it("resolves versions and records stable content fingerprints", () => {
    const catalog = new SkillCatalog();
    catalog.register({ name: "writer", version: "1", source: "memory", content: "write clearly" });
    catalog.register({ name: "writer", version: "2", source: "memory", content: "cite sources" });

    const first = catalog.resolve(skillRef("writer", "1"))!;
    const second = catalog.resolve(skillRef("writer", "2"))!;
    expect(first.content).toBe("write clearly");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(() => catalog.register({ name: "writer", version: "1", source: "other", content: "x" }))
      .toThrow(/already registered/i);
  });

  it("loads unversioned and versioned SKILL.md files from explicit paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "loop-graph-skills-"));
    temporary.push(root);
    mkdirSync(join(root, "review"), { recursive: true });
    mkdirSync(join(root, "writer", "2"), { recursive: true });
    writeFileSync(join(root, "review", "SKILL.md"), "review carefully");
    writeFileSync(join(root, "writer", "2", "SKILL.md"), "write version two");
    const catalog = new SkillCatalog();
    await catalog.loadPaths([root]);

    expect(catalog.resolve(skillRef("review"))?.content).toBe("review carefully");
    expect(catalog.resolve(skillRef("writer", "2"))?.content).toBe("write version two");
  });

  it("uses a custom resolver as the same cached source and computes the fingerprint", () => {
    let calls = 0;
    const catalog = new SkillCatalog({
      resolver(ref) {
        calls += 1;
        if (ref.name !== "remote" || ref.version !== "3") return undefined;
        return { name: ref.name, version: ref.version, source: "package:skills", content: "remote content" };
      },
    });

    const first = catalog.resolve(skillRef("remote", "3"));
    const second = catalog.resolve(skillRef("remote", "3"));
    expect(first).toMatchObject({
      name: "remote",
      version: "3",
      source: "package:skills",
      content: "remote content",
    });
    expect(first?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("rejects a custom resolver result with the wrong identity", () => {
    const catalog = new SkillCatalog({
      resolver: () => ({ name: "other", source: "generated", content: "wrong" }),
    });
    expect(() => catalog.resolve(skillRef("expected"))).toThrow(/returned other@ for expected@/i);
  });
});
