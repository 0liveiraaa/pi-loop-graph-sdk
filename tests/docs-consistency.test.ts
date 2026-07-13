import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(root, "docs");
const excludedSegments = [
  `${resolve(docsRoot, "archive")}\\`,
  `${resolve(docsRoot, "归档")}\\`,
  `${resolve(docsRoot, "重构工作区")}\\`,
];

function markdownFiles(directory: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    if (excludedSegments.some((segment) => `${path}\\`.startsWith(segment))) continue;
    if (statSync(path).isDirectory()) result.push(...markdownFiles(path));
    else if (extname(path) === ".md") result.push(path);
  }
  return result;
}

function markdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ""));
}

describe("documentation consistency", () => {
  const publicDocs = [resolve(root, "README.md"), ...markdownFiles(docsRoot)];

  it("package entry points target compiled artifacts", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const entryPoints = [
      pkg.main,
      pkg.types,
      pkg.exports["."].import,
      pkg.exports["."].types,
      pkg.exports["./extension"].import,
      pkg.exports["./extension"].types,
    ];
    expect(entryPoints.every((entry) => typeof entry === "string" && entry.startsWith("./dist/"))).toBe(true);
    expect(entryPoints.every((entry) => existsSync(resolve(root, entry)))).toBe(true);
    expect(pkg.scripts.prepare).toBe("npm run build");
  });

  it("all local Markdown links in current documentation resolve", () => {
    const broken: string[] = [];
    for (const file of publicDocs) {
      const markdown = readFileSync(file, "utf8");
      for (const rawLink of markdownLinks(markdown)) {
        if (/^(?:https?:|mailto:)/i.test(rawLink) || rawLink.startsWith("#")) continue;
        const pathPart = decodeURIComponent(rawLink.split("#", 1)[0]);
        if (!pathPart) continue;
        const target = resolve(dirname(file), pathPart);
        if (!existsSync(target)) broken.push(`${file}: ${rawLink}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("the default reading path avoids unexplained implementation vocabulary", () => {
    const defaultPath = [resolve(root, "README.md"), resolve(docsRoot, "getting-started.md")]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(defaultPath).not.toMatch(/scopeId|GraphCallScope|\bvisit\b|WeakMap|broker/);
  });

  it("new examples do not recommend deprecated tool or frame conventions", () => {
    const examples = [resolve(root, "README.md"), resolve(docsRoot, "getting-started.md")]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(examples).not.toMatch(/runAgent\s*\(\s*\{[\s\S]{0,200}?tools\s*:/);
    expect(examples).not.toMatch(/frame\s*:\s*\{\s*(?:nodeId|status|summary|result)\s*:/);
    expect(examples).toContain("output:");
  });

  it("lifecycle reference contains only the public lifecycle event names", () => {
    const lifecycle = readFileSync(resolve(docsRoot, "guides/observability.md"), "utf8");
    for (const event of ["graph_start", "graph_end", "graph_error", "node_enter", "node_exit", "compaction"]) {
      expect(lifecycle).toContain(event);
    }
    expect(lifecycle).not.toMatch(/`(?:agent_retry|agent_complete|context)`/);
  });

  it("documents the completion validation order used by PiNodeContext", () => {
    const lifecycle = readFileSync(resolve(docsRoot, "reference/lifecycle.md"), "utf8");
    const positions = [
      lifecycle.indexOf("outputSchema", lifecycle.indexOf("## 校验链顺序")),
      lifecycle.indexOf("runAgent 级 validateCompletion", lifecycle.indexOf("## 校验链顺序")),
      lifecycle.indexOf("Node.validateCompletion", lifecycle.indexOf("## 校验链顺序")),
      lifecycle.indexOf("机制 validateCompletion", lifecycle.indexOf("## 校验链顺序")),
      lifecycle.indexOf("agent-choice 校验器", lifecycle.indexOf("## 校验链顺序")),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("does not claim that debug logging is enabled by default", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    expect(readme).toContain("默认不会写调试日志文件");
    expect(readme).toContain("debug: true");
  });
});
