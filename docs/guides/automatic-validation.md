# 自动验证：确保产出正确

## 适用场景

你需要确保模型产出的结果结构正确、字段完整。Loop Graph SDK 提供三层验证。

## 1. Output Contract：声明式结构校验

Agent Node 的 `output` schema 自动成为该次 Agent Run 的 Output Contract：

```typescript
const node = agentNode({
  output: Type.Object({
    question_text: Type.String(),
    options: Type.Array(Type.String(), { minItems: 2 }),
    difficulty: Type.Union([Type.Literal("easy"), Type.Literal("medium"), Type.Literal("hard")]),
  }),
  prompt: `生成一道复习题并提交。result 格式必须匹配 Output Contract。`,
});
```

工作方式：

1. Agent Run 开始前，完整的 Output Contract schema 注入模型上下文（sticky，protected）
2. Agent 调用 `__graph_complete__` 提交 `{ result: {...} }`
3. Runtime 用同一份 schema 校验 `result`
4. 不匹配 → 拒绝（Agent 可修正后重试，最多 3 次）
5. 匹配 → 继续后续验证链

**注意**：`__graph_complete__` 只接受 `{ result }` 参数。任何额外字段（如 `status`、`reportedStatus`）都会导致提交被直接拒绝。

## 2. 验证链

```text
outputSchema 校验
  → Agent Run validator
    → Node validator
      → Route structure 检查
        → Mechanism validateCompletion（按 Node → Graph → Host 顺序）
          → agent-choice 结构检查
```

每层失败后后续层不执行。全部通过 → Agent Run 完成。

## 3. Mechanism 验证门

在 `validateCompletion` hook 中做深层验证：

```typescript
const verifyMechanism = defineMechanism({
  name: "answer-verifier",
  validateCompletion(ctx) {
    if (!ctx.completion || typeof ctx.completion !== "object" || !("answer" in ctx.completion) || typeof ctx.completion.answer !== "string") {
      return { action: "reject", reason: "缺少 answer 字段" };
    }
    if (ctx.completion.answer.length < 10) {
      return { action: "reject", reason: "答案太短" };
    }
    return { action: "allow" };
  },
});
```

Hook 顺序：Node Mechanism → Graph Mechanism → Host Mechanism。Host 拥有最终否决权。

## Code Node 中的验证

`runAgent()` 每次调用使用独立 Output Contract：

```typescript
const result = await runAgent({
  prompt: "生成计划",
  output: Type.Object({ steps: Type.Array(Type.String()) }),
});
// PlanSchema contract 到此结束

const draft = await runAgent({
  prompt: "生成草稿",
  output: Type.Object({ content: Type.String() }),
});
// 只有 DraftSchema contract 可见
```

前一个 contract 不会泄漏到后续 run。

## 拒绝与重试

每个 Agent Run 默认最多拒绝 3 次。拒绝原因直接以工具结果形式返回给模型，不额外注入重试消息。3 次超过 → `validation-exhausted` 失败。

## 相关文档

- [Mechanism](../concepts/mechanisms.md) — validateCompletion 详解
- [Mechanism 生命周期](mechanism-hooks.md) — 实操
- [API 参考](../reference/api.md) — agentNode output 签名
