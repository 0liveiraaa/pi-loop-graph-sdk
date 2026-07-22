import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineSingleAgentGraph } from "../../src/builders/graph.js";
import { agentNode } from "../../src/builders/node.js";
import { graphRef } from "../../src/core/graph.js";
import { GraphCatalog } from "../../src/host/graph-catalog.js";

const Empty = Type.Object({});

function graph(version: string) {
  return defineSingleAgentGraph({
    id: "catalog-graph",
    version,
    goal: "catalog",
    input: Empty,
    output: Empty,
    context: { background: { select: "none" } },
    node: agentNode({ subGoal: "catalog", input: Empty, output: Empty }),
  });
}

describe("GraphCatalog", () => {
  it("resolves immutable id/version references and rejects duplicate registration", () => {
    const catalog = new GraphCatalog();
    const v1 = graph("1");
    const v2 = graph("2");
    catalog.register(v1);
    catalog.register(v2);

    expect(catalog.resolve(graphRef("catalog-graph", "1"))).toBe(v1);
    expect(catalog.resolve(graphRef("catalog-graph", "2"))).toBe(v2);
    expect(catalog.resolve(graphRef("catalog-graph", "3"))).toBeUndefined();
    expect(() => catalog.register(v1)).toThrow(/already registered/i);
  });
});
