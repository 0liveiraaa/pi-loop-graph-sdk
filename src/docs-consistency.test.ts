import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function fencedCodeLineNumbers(markdown: string): number[] {
  return markdown
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => /^```/.test(line))
    .map(({ lineNumber }) => lineNumber);
}

function sourceTreePaths(markdown: string): string[] {
  const paths: string[] = [];
  const stack: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^([│ ]*)(?:├──|└──) ([^\s#]+)(?:\s|$)/);
    if (!match) continue;

    const depth = Math.floor((match[1] ?? "").length / 4);
    const name = match[2];
    stack.length = depth;

    if (name.endsWith("/")) {
      stack[depth] = name.slice(0, -1);
      continue;
    }

    if (name.includes(".")) {
      paths.push([...stack, name].filter(Boolean).join("/"));
    }
  }

  return paths;
}

describe("documentation consistency", () => {
  it("keeps fenced code blocks balanced in user-facing docs", () => {
    const files = [
      "README.md",
      "docs/README.md",
      "docs/设计/loop-graph-sdk-design.md",
      "docs/形态/implementation-status.md",
      "docs/计划/2026-07-08_review-agent-single-turn-validation.md",
    ];

    for (const file of files) {
      const fences = fencedCodeLineNumbers(read(file));
      expect(fences, `${file} has unbalanced code fences at lines ${fences.join(", ")}`)
        .toHaveLength(Math.floor(fences.length / 2) * 2);
    }
  });

  it("does not use the old package name in current public docs", () => {
    const files = [
      "README.md",
      "docs/README.md",
      "docs/形态/implementation-status.md",
      "docs/计划/2026-07-08_review-agent-single-turn-validation.md",
    ];

    for (const file of files) {
      expect(read(file), `${file} should use pi-loop-graph-sdk`)
        .not.toContain("pi-loop-graph-extension");
    }
  });

  it("implementation status only lists source files that exist", () => {
    const doc = read("docs/形态/implementation-status.md");
    const matches = [...doc.matchAll(/(?:^|[^\w/-])((?:src|docs)\/[^\s`|]+?\.(?:ts|md))/g)];
    const paths = [
      ...matches.map((match) => match[1]),
      ...sourceTreePaths(doc).map((path) => `src/${path}`),
    ];

    for (const path of paths) {
      expect(existsSync(join(root, path)), `${path} is listed but does not exist`).toBe(true);
    }
  });
});
