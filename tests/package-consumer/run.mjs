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
  for (const required of ["dist/index.js", "dist/index.d.ts", "dist/adapter/extension.js"]) {
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
const available = [
  ["pi-loop-graph-sdk", /\\/dist\\/index\\.js$/],
  ["pi-loop-graph-sdk/extension", /\\/dist\\/adapter\\/extension\\.js$/],
];

for (const [specifier, expectedPath] of available) {
  const resolved = import.meta.resolve(specifier).replaceAll("\\\\", "/");
  if (!expectedPath.test(resolved)) {
    throw new Error(specifier + " resolved outside dist: " + resolved);
  }
  await import(specifier);
}

for (const specifier of ["pi-loop-graph-sdk/replay", "pi-loop-graph-sdk/advanced"]) {
  try {
    await import(specifier);
    throw new Error(specifier + " unexpectedly exists in the 0.1 package baseline");
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
}
`);

  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], consumerRoot);
  run(process.execPath, ["verify.mjs"], consumerRoot);
  process.stdout.write("Packed consumer verified root and extension from dist; replay and advanced remain recorded 0.2 gaps.\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
