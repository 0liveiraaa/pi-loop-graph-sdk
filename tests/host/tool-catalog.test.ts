import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../../src/host/tool-catalog.js";

describe("ToolCatalog", () => {
  it("registers stable names and rejects duplicates and protocol collisions", () => {
    const catalog = new ToolCatalog();
    const read = { name: "read", description: "read files" };
    catalog.register(read);

    expect(catalog.resolve("read")).toMatchObject(read);
    expect(catalog.names).toEqual(["read"]);
    expect(() => catalog.register(read)).toThrow(/already registered/i);
    expect(() => catalog.register({ name: "__graph_complete__" })).toThrow(/invalid business tool/i);
  });
});
