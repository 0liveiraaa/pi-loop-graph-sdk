import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npmCli = process.env.npm_execpath;
const tempRoot = mkdtempSync(join(tmpdir(), "loop-graph-package-consumer-"));
const packRoot = join(tempRoot, "pack");
const consumerRoot = join(tempRoot, "consumer");

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runNpm(args, cwd) {
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd);
}

try {
  mkdirSync(packRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });

  const packResult = JSON.parse(runNpm([
    "pack",
    "--json",
    "--pack-destination",
    packRoot,
  ], repoRoot))[0];
  const tarball = join(packRoot, packResult.filename);
  const packedPaths = packResult.files.map((file) => file.path.replaceAll("\\", "/"));

  if (packedPaths.some((path) => path === "src" || path.startsWith("src/"))) {
    throw new Error("Published tarball unexpectedly contains src/");
  }
  if (packedPaths.some((path) => path.startsWith("dist/graphs/"))) {
    throw new Error("Published tarball unexpectedly contains demo graphs");
  }
  if (packedPaths.includes("dist/registry.js") || packedPaths.includes("dist/registry.d.ts")) {
    throw new Error("Published tarball unexpectedly contains the legacy global registry");
  }
  for (const required of ["dist/index.js", "dist/index.d.ts", "dist/adapter/extension.js", "dist/replay/index.js", "dist/replay/index.d.ts"]) {
    if (!packedPaths.includes(required)) {
      throw new Error(`Published tarball is missing ${required}`);
    }
  }

  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  writeFileSync(join(consumerRoot, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "pi-loop-graph-sdk": `file:${tarball}`,
      "@earendil-works/pi-coding-agent": rootPackage.devDependencies["@earendil-works/pi-coding-agent"],
      "@earendil-works/pi-tui": rootPackage.devDependencies["@earendil-works/pi-tui"],
    },
  }, null, 2));

  writeFileSync(join(consumerRoot, "verify.mjs"), `
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const available = [
  ["pi-loop-graph-sdk", /\\/dist\\/index\\.js$/],
  ["pi-loop-graph-sdk/extension", /\\/dist\\/adapter\\/extension\\.js$/],
  ["pi-loop-graph-sdk/replay", /\\/dist\\/replay\\/index\\.js$/],
  ["pi-loop-graph-sdk/advanced", /\\/dist\\/advanced\\.js$/],
];

for (const [specifier, expectedPath] of available) {
  const resolved = import.meta.resolve(specifier).replaceAll("\\\\", "/");
  if (!expectedPath.test(resolved)) {
    throw new Error(specifier + " resolved outside dist: " + resolved);
  }
  await import(specifier);
}

const root = await import("pi-loop-graph-sdk");
for (const name of [
  "ContextState",
  "materializeProjection",
  "prepareOutputContract",
  "defaultCompletionFeedbackFormatter",
  "defaultSkillContentProvider",
  "DEFAULT_HOST_BASELINE",
  "DEFAULT_INVOCATION_LIMITS",
  "GraphRuntime",
  "ToolCatalog",
  "SkillCatalog",
]) {
  if (name in root) throw new Error(name + " must not be exported from the package root");
}
const rootDeclarations = readFileSync(join(dirname(fileURLToPath(import.meta.resolve("pi-loop-graph-sdk"))), "index.d.ts"), "utf8");
for (const name of ["Entry", "ContextFrame"]) {
  const declarations = rootDeclarations;
  if (!declarations.includes(name)) throw new Error(name + " is missing from root declarations");
}

const { ToolCatalog, SkillCatalog } = await import("pi-loop-graph-sdk/advanced");
if (new ToolCatalog().constructor.name !== "ToolCatalog") {
  throw new Error("ToolCatalog is not available as an /advanced value export");
}
if (new SkillCatalog().constructor.name !== "SkillCatalog") {
  throw new Error("SkillCatalog is not available as an /advanced value export");
}

`);

  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], consumerRoot);
  run(process.execPath, ["verify.mjs"], consumerRoot);
  process.stdout.write("Packed consumer verified root, replay, advanced, and extension from dist.\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
