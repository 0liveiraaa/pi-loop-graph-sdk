# 构建条件路由与循环

## 适用场景

你需要节点完成后根据结果走向不同阶段，或让某个节点在失败时回到自身重试。

术语定义见[图模型](../concepts/graph-model.md)。

## 完成示例

以下图：批改节点在结果不通过时自环重试，通过后走向总结节点。

```typescript
import { Type, defineGraph, agentNode, entry, connect, finish, firstMatch } from "pi-loop-graph-sdk";

const 批改节点 = agentNode({
  subGoal: "批改答案并给出评分",
  input: Type.Object({ answer: Type.String(), attempt: Type.Number() }),
  output: Type.Object({ answer: Type.String(), attempt: Type.Number(), score: Type.Number(), passed: Type.Boolean(), feedback: Type.String() }),
  prompt: `请批改以下答案并提交，result 格式：
{ "answer": "原答案", "attempt": <当前次数>, "score": <数字0-100>, "passed": <布尔值>, "feedback": "<批语>" }。
保留原答案和当前 attempt。`,
});

const 总结节点 = agentNode({
  subGoal: "总结本轮复习情况",
  input: Type.Object({ feedback: Type.String(), score: Type.Number() }),
  output: Type.Object({ summary: Type.String() }),
  prompt: `基于批改结果总结复习情况并提交。`,
});

export const 批改图 = defineGraph({
  id: "grading-loop",
  version: "1",
  goal: "批改答案，不通过则重试",
  input: Type.Object({ answer: Type.String() }),
  output: Type.Object({ summary: Type.String() }),
  context: {
    background: { select: "all" },
    memory: { select: "all" },
  },
  entries: [entry("main", {
    to: "grade",
    mapInput: (input: { readonly answer: string }) => ({ answer: input.answer, attempt: 1 }),
  })],

  stages: {
    grade: {
      node: 批改节点,
      route: firstMatch({
        // guard 匹配 → 回到 grade（自环重试）
        retry: connect("grade", {
          guard: (result) => !result.passed,
          map: ({ completion }) => ({
            answer: completion.result.answer,
            attempt: completion.result.attempt + 1,
          }),
          frame: ({ completion }) => ({
            attempt: completion.result.attempt,
            feedback: completion.result.feedback,
          }),
        }),
        // 默认 → 到 summary
        next: connect("summary", {
          map: ({ completion }) => ({
            score: completion.result.score,
            feedback: completion.result.feedback,
          }),
          frame: ({ completion }) => ({
            finalScore: completion.result.score,
          }),
        }),
      }),
    },

    summary: {
      node: 总结节点,
      route: firstMatch({
        done: finish({
          output: ({ completion }) => completion.result,
        }),
      }),
    },
  },
});
```

## 运行过程

1. 用户传入 `{ answer: "..." }` → Entry 匹配 → 进入 `grade`
2. Agent 批改 → 提交 `{ answer: "...", attempt: 1, score: 40, passed: false, feedback: "不充分" }`
3. `retry` Connection 的 guard 匹配（`!result.passed`）→ 回到 `grade`
4. 第二次批改 → 提交 `{ answer: "...", attempt: 2, score: 80, passed: true, feedback: "通过" }`
5. `retry` guard 不匹配 → 走 `next` → 进入 `summary`，Node Input 包含 score 和 feedback
6. Agent 总结 → finish → 返回 Graph Output

## guard 函数

`transition.guard` 接收 `completion.result` 并返回 boolean：

```typescript
guard: (result) => result.score < 60,
```

firstMatch 按 `Record` 定义顺序评估，首个 guard 返回 true 的连接被选中。没有匹配项时图以 `no-route` 失败。

## frame：保存工作记忆

`transition.frame` 在迁移时写入 Frame。后续节点通过 Memory 投影看到：

```typescript
frame: ({ completion }) => ({
  stage: "grade",
  score: completion.result.score,
  timestamp: Date.now(),
}),
```

## agent-choice 路由

除了 `firstMatch`，还可以让**模型自己选择**下一步。使用 `agent-choice` 需要自定义 Router（见 `pi-loop-graph-sdk/advanced` 子路径）。标准 Builder 仅提供 `firstMatch`。

## 边界与错误

- 没有 guard 匹配 → `no-route` 失败
- 无限循环受 Root Invocation Budget 限制：maxGraphDepth 8、maxGraphInvocations 64、maxTotalNodeVisits 500
- 超过预算 → `max-steps-exceeded` 失败

## 相关文档

- [图模型](../concepts/graph-model.md) — Connection、Transition、guard、frame
- [上下文与状态](../concepts/context-and-state.md) — Memory 投影
- [混合代码与 Agent](mix-code-and-agent.md) — 用 codeNode 做条件判断
