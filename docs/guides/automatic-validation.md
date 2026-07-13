# 自动验证：outputSchema、Validator 与验证门

## 适用场景

你需要确保 LLM 产出的结果结构正确、字段完整，或通过外部自动化测试来确认节点工作真正完成。Loop Graph SDK 提供三层验证，从轻到重依次叠加。

## 最小代码

### 1. outputSchema：声明式结构校验

```typescript
import { createAgentExecute } from "pi-loop-graph-sdk";
import type { Mechanism, Node } from "pi-loop-graph-sdk";

const questionNode: Node = {
  kind: "code",
  id: "generate_question",
  subGoal: "生成复习题目",
  execute: createAgentExecute({
    outputSchema: {
      type: "object",
      properties: {
        question_text: { type: "string" },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
        },
        difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
      },
      required: ["question_text", "options", "difficulty"],
    },
  }),
};
```

SDK 会在这次 Agent Run 的首个 turn 前把完整 JSON Schema 展示给 LLM；Runtime 再用同一份 schema 校验 `result`。不符合时，本次 `__graph_complete__` 的工具结果直接返回拒绝原因，节点不退出，LLM 可以修正后再次提交。

`outputSchema` 属于一次 `ctx.runAgent()`，不是 Node 的固定结构。同一节点连续调用两次 `runAgent()` 时可以使用不同 schema。schema 默认最多 64 KiB；不可稳定序列化或超限会在 Agent Run 启动前报错，不会悄悄截断。

### 2. validateCompletion：自定义验证函数

```typescript
const gradeNode: Node = {
  kind: "code",
  id: "grade_answer",
  subGoal: "批改答案",
  execute: createAgentExecute(),
  validateCompletion(result) {
    if (!result.score && result.score !== 0) {
      return { isValid: false, reason: "缺少 score 字段" };
    }
    if (result.score < 0 || result.score > 100) {
      return { isValid: false, reason: "score 必须在 0-100 之间" };
    }
    return { isValid: true };
  },
};
```

`validateCompletion` 只在 `completion.status === "ok"` 时执行。`failed` 和 `cancelled` 不经过验证，直接进入路由。

也可以在 `execute` 函数内通过 `ctx.runAgent` 传入验证：

```typescript
execute: async (instance, input, ctx) => {
  return ctx.runAgent({
    prompt: "请批改...",
    validateCompletion(result) {
      if (!result.score) return { isValid: false, reason: "缺少 score" };
      return { isValid: true };
    },
  });
}
```

### 3. 机制层验证门：可信外部验收

当验证需要执行外部命令（如运行单元测试）时，使用机制：

```typescript
const testGate: Mechanism = {
  name: "test-gate",
  failurePolicy: "fail-graph", // 基础设施异常时不要静默放行
  async validateCompletion(ctx) {
    const test = await ctx.exec.run("npm", ["test"], {
      timeoutMs: 60_000,
    });

    if (test.code !== 0) {
      return { action: "reject", reason: "单元测试未通过" };
    }

    return {
      action: "allow",
      // verifiedResult 由 Runtime 顶层生成，AI 无法伪造
      verifiedResult: { exitCode: test.code, output: test.stdout },
    };
  },
};
```

`verifiedResult` 由 Runtime 在 `completion` 的顶层字段 `verifiedResult.checks` 中生成。即使 AI 在 `result` 中写入伪造的 `verifiedResult`，也不会覆盖 Runtime 的生成值。

## 校验顺序

三层校验按固定顺序执行，前一层失败时后续层不执行：

```text
outputSchema → 本次 runAgent 的 validateCompletion → Node.validateCompletion → 机制验证门 → agent-choice 校验
```

机制层的 `validateCompletion` 在代码侧验证之后运行，多个机制按注册顺序依次判定。最后，`agent-choice` 校验确认 AI 选择了真实存在的边。上述任一步拒绝完成，都会在当前完成工具结果中把原因发回 LLM，让当前 Agent Run 继续工作。

## 运行流程

1. LLM 调用 `__graph_complete__({ status: "ok", result: {...} })`。
2. Runtime 依次运行各层验证。
3. 任一验证返回 `isValid: false`（或 reject）时，本次工具结果返回 Runtime 的拒绝原因；原始 `status/result` 不会被 SDK 再次回显。
4. LLM 可在同一次 Agent Run 中修正并再次调用 `__graph_complete__`。
5. 全部验证通过 → Runtime 接受提交、生成 `NodeCompletion`，节点进入路由选择。

## 安全边界与常见错误

- **验证只在 `status === "ok"` 时执行**：如果 LLM 主动以 `status: "failed"` 完成节点，验证不会触发。不要依赖验证来捕获所有异常情况。
- **不要假设 `outputSchema` 会执行自定义逻辑**：`outputSchema` 只能做 JSON Schema 校验，不能调外部 API 或访问文件。
- **`validateCompletion` 允许异步调用但不建议在其中做长时间 HTTP 请求**：这会阻塞节点完成。耗时验证应放在机制层，那里有独立 timeout 控制。
- **不要忘记 `failurePolicy`**：机制层验证的 `failurePolicy` 默认为 `continue`（静默放行）。如果你在验证中执行 `ctx.exec.run`，异常可能被吞掉。建议设为 `"fail-graph"` 或 `"fail-node"`。
- **`verifiedResult` 与 AI 自报 result 分离**：Runtime 的 `completion.verifiedResult.checks` 由框架生成，AI 写入同名字段无效。不要在代码中混淆两者的来源。

## 相关概念

- [节点模型](../concepts/glossary.md)
- [机制 Hooks](mechanism-hooks.md) — validateCompletion 的完整上下文
- [构建循环](build-a-loop.md) — 验证失败后如何配合自环重试
