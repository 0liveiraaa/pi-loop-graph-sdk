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

function edge(id: string, priority: number, guard = true, description?: string): Edge {
  return {
    id,
    from: "start",
    to: END,
    priority,
    description,
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

  describe("agent-choice", () => {
    it("returns the only matched edge when exactly one passes guard", async () => {
      const only = edge("only", 10, true, "唯一可用边");

      await expect(
        selectEdge(
          routing([only, edge("closed", 1, false, "不会匹配")], { kind: "agent-choice" }),
          completion,
          instance,
        ),
      ).resolves.toBe(only);
    });

    it("selects the edge declared by agent in completion.result.chosen_edge_id", async () => {
      const first = edge("first", 1, true, "低优先级但被选择");
      const second = edge("second", 10, true, "高优先级但未被选择");

      const withChoice = {
        ...completion,
        result: { ...completion.result, chosen_edge_id: "first" },
      };

      await expect(
        selectEdge(
          routing([first, second], { kind: "agent-choice" }),
          withChoice,
          instance,
        ),
      ).resolves.toBe(first);
    });

    it("respects custom agentChoiceField name", async () => {
      const chosen = edge("chosen", 10, true, "被选中");
      const other = edge("other", 1, true, "未被选中");

      const withCustomField = {
        ...completion,
        result: { ...completion.result, my_choice: "chosen" },
      };

      await expect(
        selectEdge(
          { nodeId: "start", edges: [chosen, other], router: { kind: "agent-choice" }, agentChoiceField: "my_choice" },
          withCustomField,
          instance,
        ),
      ).resolves.toBe(chosen);
    });

    it("falls back to priority-first when agent does not declare chosen_edge_id", async () => {
      const low = edge("low", 1, true, "低优先级");
      const high = edge("high", 10, true, "高优先级");

      await expect(
        selectEdge(
          routing([low, high], { kind: "agent-choice" }),
          completion, // no chosen_edge_id in result
          instance,
        ),
      ).resolves.toBe(high);
    });

    it("falls back to priority-first when agent declares a non-existent edge id", async () => {
      const real = edge("real", 10, true, "真实边");
      const withBadChoice = {
        ...completion,
        result: { ...completion.result, chosen_edge_id: "nonexistent" },
      };

      await expect(
        selectEdge(
          routing([real], { kind: "agent-choice" }),
          withBadChoice,
          instance,
        ),
      ).resolves.toBe(real);
    });
  });
});
