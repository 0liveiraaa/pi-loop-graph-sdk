# 混合代码与 Agent

## 适用场景

你需要在节点中既做确定性处理（读写文件、调 API、计算），又驱动 Agent 推理。Loop Graph SDK 的 `codeNode` 支持任意次数调用 `runAgent()`。

## 模式 1：纯 Agent 节点

最简单的情况 — 节点只做一次 Agent Run：

```typescript
import { agentNode } from "pi-loop-graph-sdk";

const node = agentNode({
  subGoal: "批改答案",
  input: InputSchema,
  output: OutputSchema,
  prompt: "请批改以下答案...",
});
```

`agentNode` 的 `output` 同时是 Agent Run 的 Output Contract 和 Node Completion 的校验来源。Runtime 自动处理工具调用和结果提交。

## 模式 2：Code 节点 + 单次 runAgent

在 Agent 调用前后做数据处理：

```typescript
import { Type, codeNode } from "pi-loop-graph-sdk";

const node = codeNode({
  subGoal: "加载数据 → Agent 分析 → 保存结果",
  input: Type.Object({ filePath: Type.String() }),
  output: Type.Object({ report: Type.String() }),

  async execute({ input, complete, runAgent }) {
    // 前置：读文件、调 API
    const raw = await loadFile(input.filePath);

    // 调 Agent
    const analysis = await runAgent({
      prompt: `分析以下内容：${raw}`,
      output: Type.Object({ summary: Type.String(), tags: Type.Array(Type.String()) }),
    });
    const typed = analysis.result as { summary: string; tags: string[] };

    // 后置：保存结果
    await saveResult(analysis.result);

    return complete({ report: typed.summary });
  },
});
```

`runAgent()` 的 `output` 是该次 Agent Run 的 Output Contract，run 返回后立即删除，不会泄漏到后续 run。

## 模式 3：Code 节点 + 多次 runAgent

先规划，再生成：

```typescript
const node = codeNode({
  subGoal: "先规划，再生成",
  input: Type.Object({ topic: Type.String() }),
  output: Type.Object({ draft: Type.String() }),

  async execute({ input, complete, runAgent }) {
    const plan = await runAgent({
      prompt: `为以下主题生成大纲：${input.topic}`,
      output: Type.Object({ outline: Type.Array(Type.String()) }),
    });
    const typedPlan = plan.result as { outline: string[] };

    const draft = await runAgent({
      prompt: `按照大纲生成草稿：${JSON.stringify(typedPlan.outline)}`,
      output: Type.Object({ content: Type.String() }),
    });
    const typedDraft = draft.result as { content: string };

    return complete({ draft: typedDraft.content });
  },
});
```

每次 `runAgent()` 使用独立 Output Contract，前一个 contract 绝不会出现在后一个 run 的上下文中。

## 模式 4：Code 节点 + 条件 runAgent

只在需要时调 Agent：

```typescript
async execute({ input, complete, runAgent }) {
  const result = await fastCheck(input);

  if (result.needsReview) {
    const review = await runAgent({
      prompt: `复核：${JSON.stringify(result)}`,
      output: ReviewSchema,
    });
    return complete(review.result);
  }

  return complete({ passed: true });
}
```

## runAgent() 的上下文

Code Node 默认不向模型注入 Node Focus（`context.focus: "none"`）。要启用，显式配置：

```typescript
const node = codeNode({
  context: {
    focus: { select: (input) => ({ topic: input.topic }) },
  },
  // 现在 runAgent() 自动获得 Node Focus
});
```

## 相关文档

- [自动验证](automatic-validation.md) — outputSchema 校验
- [自定义上下文](customize-context.md) — select/render 配置
- [API 参考](../reference/api.md) — codeNode、agentNode 完整签名
