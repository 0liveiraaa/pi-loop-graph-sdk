import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { defineGraph } from "../../src/builders/graph.js";
import { codeNode } from "../../src/builders/node.js";
import { connect, entry, finish, firstMatch } from "../../src/builders/route.js";
import { createGraphHost, executeIsolatedGraph } from "../../src/host/graph-host.js";

const graph = defineGraph({
  id: "host-test", version: "1", goal: "host", input: Type.Object({ value: Type.Number() }), output: Type.Object({ value: Type.Number() }),
  context: { background: { select: "none", render: () => null }, memory: { select: "none", render: () => null } },
  entries: [entry("start", { to: "start" })],
  stages: {
    start: { node: codeNode({ subGoal: "echo", input: Type.Object({ value: Type.Number() }), output: Type.Object({ value: Type.Number() }), execute: ({ input }) => input }), route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }) },
  },
});

describe("Phase 7 GraphHost", () => {
  it("executes Core Graph and rejects reuse after dispose", async () => {
    const host = createGraphHost();
    await expect(host.execute(graph, { value: 1 })).resolves.toMatchObject({ status: "completed", output: { value: 1 } });
    await host.dispose();
    await expect(host.execute(graph, { value: 2 })).rejects.toThrow("已释放");
  });

  it("executeIsolatedGraph always disposes", async () => {
    const dispose = vi.fn();
    const result = await executeIsolatedGraph(graph, { input: { value: 3 }, createHost: () => createGraphHost({ dispose }) });
    expect(result).toMatchObject({ status: "completed", output: { value: 3 } });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("one host rejects concurrent roots", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const slow = defineGraph({ ...graph, id: "slow-host", stages: { start: { ...graph.stages.start, node: codeNode({ ...graph.stages.start.node as any, execute: async ({ input }: any) => { await pending; return input; } }) } } });
    const host = createGraphHost();
    const first = host.execute(slow, { value: 1 });
    await expect(host.execute(slow, { value: 2 })).rejects.toThrow("并发运行");
    release();
    await first;
    await host.dispose();
  });

  it("dispose aborts and waits for the active Root Run before releasing resources", async () => {
    const dispose = vi.fn();
    const slow = defineGraph({
      ...graph,
      id: "dispose-active",
      stages: {
        start: {
          ...graph.stages.start,
          node: codeNode({
            ...graph.stages.start.node as any,
            execute: async ({ input }) => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return input;
            },
          }),
        },
      },
    });
    const host = createGraphHost({ dispose });
    const running = host.execute(slow, { value: 1 }, { recording: "off" });
    const disposing = host.dispose();
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    await disposing;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not allow per-run limits to enlarge Host hard limits", async () => {
    const twoSteps = defineGraph({
      ...graph,
      id: "host-hard-limits",
      stages: {
        first: {
          node: graph.stages.start.node,
          route: firstMatch({ next: connect("second", { map: ({ completion }) => completion.result }) }),
        },
        second: graph.stages.start,
      },
      entries: [entry("start", { to: "first" })],
    });
    const host = createGraphHost({ limits: { maxGraphDepth: 8, maxGraphInvocations: 64, maxTotalNodeVisits: 1 } });
    try {
      await expect(host.execute(twoSteps, { value: 1 }, {
        limits: { maxGraphDepth: 99, maxGraphInvocations: 999, maxTotalNodeVisits: 999 },
        recording: "off",
      })).resolves.toMatchObject({
        status: "failed",
        failure: { code: "max-steps-exceeded" },
      });
    } finally {
      await host.dispose();
    }
  });
});
