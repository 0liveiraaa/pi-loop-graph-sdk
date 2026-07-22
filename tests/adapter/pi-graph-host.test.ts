import { beforeAll, describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiGraphHost } from "../../src/adapter/isolated-graph-session.js";
import { defineGraph } from "../../src/builders/graph.js";
import { codeNode, graphNode } from "../../src/builders/node.js";
import { connect, entry, finish, firstMatch } from "../../src/builders/route.js";
import { graphRef } from "../../src/core/graph.js";
import { FileRunStore } from "../../src/replay/store.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const Value = Type.Object({ value: Type.Number() });

const child = defineGraph({
  id: "pi-host-catalog-child", version: "1", goal: "increment", input: Value, output: Value,
  context: { background: { select: "all" } },
  entries: [entry("main", { to: "increment" })],
  stages: {
    increment: {
      node: codeNode({ subGoal: "increment", input: Value, output: Value, execute: ({ input, complete }) => complete({ value: input.value + 1 }) }),
      route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
    },
  },
});

const root = defineGraph({
  id: "pi-host-catalog-root", version: "1", goal: "invoke child", input: Value, output: Value,
  context: { background: { select: "all" } },
  entries: [entry("main", { to: "child" })],
  stages: {
    child: {
      node: graphNode({ subGoal: "invoke child", input: Value, output: Value, graph: graphRef(child.id, child.version), boundary: "compose" }),
      route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
    },
  },
});

describe("createPiGraphHost Graph Catalog lifetime", () => {
  let authStorage: AuthStorage;
  let modelRegistry: ModelRegistry;

  beforeAll(() => {
    authStorage = AuthStorage.create();
    modelRegistry = ModelRegistry.create(authStorage);
  });

  it("resolves registered child GraphRefs from the final Pi extension instance", async () => {
    const host = await createPiGraphHost({ authStorage, modelRegistry, graphs: [child, root], recording: "off" });
    try {
      await expect(host.execute(root, { value: 1 }, { recording: "off" })).resolves.toMatchObject({
        status: "completed",
        output: { value: 2 },
      });
    } finally {
      await host.dispose();
    }
  });

  it("executes delegate children through an isolated invocation Agent Host", async () => {
    const delegatedRoot = defineGraph({
      ...root,
      id: "pi-host-catalog-delegate-root",
      stages: {
        child: {
          node: graphNode({ subGoal: "delegate child", input: Value, output: Value, graph: graphRef(child.id, child.version), boundary: "delegate" }),
          route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
        },
      },
    });
    const host = await createPiGraphHost({ authStorage, modelRegistry, graphs: [child, delegatedRoot], recording: "off" });
    try {
      await expect(host.execute(delegatedRoot, { value: 4 }, { recording: "off" })).resolves.toMatchObject({
        status: "completed",
        output: { value: 5 },
      });
    } finally {
      await host.dispose();
    }
  });

  it("writes and resumes a code-only root checkpoint through the Pi GraphHost", async () => {
    const first = codeNode({ subGoal: "first", input: Value, output: Value, execute: ({ input, complete }) => complete({ value: input.value + 1 }) });
    const second = codeNode({ subGoal: "second", input: Value, output: Value, execute: ({ input, complete }) => complete({ value: input.value + 1 }) });
    const graph = defineGraph({ id: "pi-host-resume", version: "1", goal: "resume", input: Value, output: Value,
      context: { background: { select: "all" } }, entries: [entry("main", { to: "first" })], stages: {
        first: { node: first, route: firstMatch({ next: connect("second", { map: ({ completion }) => completion.result }) }) },
        second: { node: second, route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }) },
      } });
    const store = new FileRunStore(await mkdtemp(join(tmpdir(), "loop-graph-pi-resume-")));
    const host = await createPiGraphHost({ authStorage, modelRegistry, graphs: [graph], runStore: store, recording: "off" });
    try {
      const executed = await host.execute(graph, { value: 0 }, { recording: "off" });
      expect(executed).toMatchObject({ status: "completed", output: { value: 2 } });
      expect((await store.listCheckpoints(executed.rootRunId)).length).toBe(1);
      await expect(host.resume(graph, { runId: executed.rootRunId, recording: "off" })).resolves.toMatchObject({ status: "completed", output: { value: 2 } });
    } finally {
      await host.dispose();
    }
  });
});
