import { beforeAll, describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiGraphHost } from "../../src/adapter/isolated-graph-session.js";
import { defineGraph } from "../../src/builders/graph.js";
import { codeNode, graphNode } from "../../src/builders/node.js";
import { entry, finish, firstMatch } from "../../src/builders/route.js";
import { graphRef } from "../../src/core/graph.js";

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
});
