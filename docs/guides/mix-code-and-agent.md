# 混合代码与 Agent 推理

## 适用场景

你在一个节点中需要既有纯代码逻辑（读写文件、调 API、计算），又有 LLM 推理（分析文本、做决策、生成内容）。Loop Graph SDK 支持三种模式自由组合。

## 最小代码

### 1. agent-only：只调 LLM

```typescript
import { createAgentExecute } from "pi-loop-graph-sdk";
import type { Node } from "pi-loop-graph-sdk";

const gradeNode: Node = {
  kind: "code",
  id: "grade_answer",
  subGoal: "批改用户答案",
  skill: "review-grade",
  execute: createAgentExecute({
    prompt: (input) => `请批改：${input.data.answer}`,
  }),
};
```

`createAgentExecute` 是语法糖，等价于：

```typescript
execute: (instance, input, ctx) =>
  ctx.runAgent({
    prompt: `请批改：${input.data.answer}`,
    skill: "review-grade",
  })
```

> 重要：Agent 只看你在 `prompt` 中显式传入的信息。框架不会自动把 `input.data` 的内容注入上下文。

### 2. code-only：只走代码

```typescript
import fs from "node:fs";

const saveNode: Node = {
  kind: "code",
  id: "save_result",
  subGoal: "持久化批改结果",
  execute: async (instance, input, ctx) => {
    const path = input.data.outputPath as string;
    fs.writeFileSync(path, JSON.stringify(input.data.payload));
    return { nodeId: "save_result", status: "ok", result: { saved: true } };
  },
};
```

code-only 节点不使用 `runAgent`，也不依赖 pi 的工具系统。`execute` 就是普通异步函数。
返回值中的 `nodeId` 必须与当前节点的 `id` 相同；它是完成信号的一部分，不是工作记忆的固定结构。

### 3. hybrid：代码与 Agent 穿插

```typescript
const analyzeNode: Node = {
  kind: "code",
  id: "analyze",
  subGoal: "读取文件并用 LLM 分析",
  execute: async (instance, input, ctx) => {
    // 步骤 1：代码侧准备数据
    const content = fs.readFileSync(input.data.filePath, "utf-8");
    const rules = await externalAPI.getRules(input.data.tenantId);

    // 步骤 2：Agent 推理
    const analysis = await ctx.runAgent({
      prompt: `按以下规则分析文件内容：
规则：${JSON.stringify(rules)}
内容：${content}`,
    });

    // 步骤 3：代码侧处理结果
    if (analysis.status === "ok") {
      fs.writeFileSync(
        input.data.reportPath,
        JSON.stringify(analysis.result),
      );
    }

    return analysis;
  },
};
```

三种模式可以任意组合。同一个 `execute` 函数中可以多次调用 `ctx.runAgent`，每次之间穿插代码逻辑。

## 运行顺序

1. `execute` 被调用，接收 `instance`、`input`、`ctx`。
2. 代码侧逻辑按顺序执行，遇到 `await ctx.runAgent(...)` 时将控制权交给 LLM。
3. LLM 完成推理后返回 `NodeCompletion`，代码继续执行后续逻辑。
4. `execute` 最终返回的 `NodeCompletion` 进入路由判断。

## 安全边界与常见错误

- **不要用 `runAgent().tools`**：工具白名单应通过 `Node.tools` 声明，而不是在 `runAgent` 参数中传递。框架通过 `resolveNodeTools(defaultTools, node.tools)` 合并工具集。
- **code-only 节点不需要 `__graph_complete__`**：只有 agent 推理时需要。code-only 节点的 `execute` 直接返回 `NodeCompletion`。
- **`ctx.runAgent` 和 Node 层的工具互不冲突**：节点的 `tools` 声明控制当前节点内 LLM 可见的全部工具，无论在 execute 中调用几次 `runAgent`。
- **`runAgent` 报错不会自动重试**：如果有网络或模型错误，需要在 execute 中自行 try/catch 并决定返回 `status: "failed"` 还是 `status: "cancelled"`。
- **`execute` 的 `ctx` 不直接提供 pi 能力**：`NodeContext` 只提供取消信号、`runAgent` 和 `callTool`。需要监听事件、注册清理或执行受生命周期约束的副作用时，请使用机制（Mechanism）。只有机制上下文中的 `ctx.pi` 才是完整但非托管的高级入口。

## 相关概念

- [工具控制](control-tools.md) — 如何配置节点可用工具
- [验证](automatic-validation.md) — 在 `createAgentExecute` 中加 `validateCompletion`
- [机制 Hooks](mechanism-hooks.md) — 在 hybrid 节点前后插入横切逻辑
