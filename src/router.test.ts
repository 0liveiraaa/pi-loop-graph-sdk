import { describe, expect, it } from "vitest";
import { selectEdge } from "./router.js";
import type { AgentInstance, Edge, NodeCompletion, NodeRouting } from "./type.js";
import { END } from "./type.js";

const completion: NodeCompletion = {
  nodeId: "start",
  status: "ok",
  result: { route: "done" },
};

const instance: AgentInstance = {
  id: "agent-1",
  globalGoal: "test graph",
  background: {},
  frames: [],
  mechanisms: [],
  scratch: {},
};

function edge(id: string, priority: number, guard = true): Edge {
  return {
    id,
    from: "start",
    to: END,
    priority,
    guard: () => guard,
    migrate(_instance, nodeCompletion) {
      return {
        frame: {
          nodeId: nodeCompletion.nodeId,
          status: nodeCompletion.status,
          summary: id,
          result: nodeCompletion.result,
        },
      };
    },
  };
}

function routing(
  edges: Edge[],
  router: NodeRouting["router"],
): NodeRouting {
  return { nodeId: "start", edges, router };
}

describe("selectEdge", () => {
  it("first-match selects the first guarded edge", async () => {
    const skipped = edge("skipped", 100, false);
    const first = edge("first", 1);
    const second = edge("second", 100);

    await expect(
      selectEdge(
        routing([skipped, first, second], { kind: "first-match" }),
        completion,
        instance,
      ),
    ).resolves.toBe(first);
  });

  it("priority-first selects the highest priority edge and preserves same-priority order", async () => {
    const low = edge("low", 1);
    const highFirst = edge("high-first", 10);
    const highSecond = edge("high-second", 10);

    await expect(
      selectEdge(
        routing([low, highFirst, highSecond], { kind: "priority-first" }),
        completion,
        instance,
      ),
    ).resolves.toBe(highFirst);
  });

  it("ignores throwing guards and returns null when nothing matches", async () => {
    const throwing = edge("throwing", 10);
    throwing.guard = () => {
      throw new Error("guard failed");
    };

    await expect(
      selectEdge(
        routing([throwing, edge("closed", 1, false)], { kind: "first-match" }),
        completion,
        instance,
      ),
    ).resolves.toBeNull();
  });

  it("awaits custom routers so they can make asynchronous decisions", async () => {
    const first = edge("first", 1);
    const selected = edge("selected", 2);

    await expect(
      selectEdge(
        routing([first, selected], {
          kind: "custom",
          async fn(edges) {
            await Promise.resolve();
            return edges.find((candidate) => candidate.id === "selected") ?? null;
          },
        }),
        completion,
        instance,
      ),
    ).resolves.toBe(selected);
  });

  it("keeps agent-choice explicit until the strategy is implemented", async () => {
    await expect(
      selectEdge(
        routing([edge("candidate", 1)], { kind: "agent-choice" }),
        completion,
        instance,
      ),
    ).rejects.toThrow("agent-choice 未实现");
  });
});
