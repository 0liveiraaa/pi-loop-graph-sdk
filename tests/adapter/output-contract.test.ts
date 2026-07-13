import { describe, expect, it } from "vitest";
import {
  prepareOutputContract,
} from "../../src/adapter/output-contract.js";

describe("output contract", () => {
  it("递归排序后生成稳定文本与指纹", () => {
    const left = prepareOutputContract({
      required: ["z", "a"],
      properties: { z: { type: "number" }, a: { type: "string" } },
      additionalProperties: false,
      type: "object",
    })!;
    const right = prepareOutputContract({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" }, z: { type: "number" } },
      required: ["z", "a"],
    })!;

    expect(left.serialized).toBe(right.serialized);
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(left.modelText).toContain('"required"');
    expect(left.modelText).toContain('"additionalProperties": false');
  });

  it("模型看到的 schema 与 Runtime validator 来自同一份规范化对象", () => {
    const contract = prepareOutputContract({
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
      additionalProperties: false,
    })!;

    expect(contract.validate({ answer: 42 })).toEqual({ isValid: true });
    expect(contract.validate({ answer: "42" })).toMatchObject({ isValid: false });
    expect(contract.validate({ answer: 42, extra: true })).toMatchObject({ isValid: false });
    expect(JSON.parse(contract.serialized)).toEqual(contract.schema);
  });

  it.each([
    ["函数", { type: "object", custom: () => undefined }],
    ["非有限数字", { type: "object", custom: Number.NaN }],
    ["非普通对象", { type: "object", custom: new Date() }],
  ])("拒绝不可稳定序列化的 JSON Schema：%s", (_label, schema) => {
    expect(() => prepareOutputContract(schema as any)).toThrow();
  });

  it("拒绝循环引用和超过预算的 schema", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    expect(() => prepareOutputContract(cyclic)).toThrow(/循环引用/);
    expect(() => prepareOutputContract({ type: "object", description: "x".repeat(100) }, 32))
      .toThrow(/超过 outputContractMaxBytes/);
  });
});
