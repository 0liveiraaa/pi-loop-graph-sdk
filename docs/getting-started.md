# 十分钟快速开始

这篇教程带你从零创建一个 pi extension，定义一张包含两个阶段的 Agent 图并运行它。

## 1. 前置条件

- Node.js 20+；
- 一个能加载 TypeScript extension 的 pi 环境；
- pi coding agent 已安装并完成模型认证。

## 2. 安装

在你的 extension 项目中：

```bash
npm install pi-loop-graph-sdk
```

## 3. 定义图

创建 `src/my-graph.ts`。一张图由**目标**、**输入输出契约**、**入口**和**阶段**组成。

每个阶段把**节点**（做什么）和**路由**（做完之后去哪）装配在一起。

```typescript
import {
  Type,
  defineGraph,
  agentNode,
  entry,
  connect,
  finish,
  firstMatch,
} from "pi-loop-graph-sdk";

// ── 节点定义 ──

const 分析节点 = agentNode({
  subGoal: "分析问题并给出思路",
  input: Type.Object({ question: Type.String() }),
  output: Type.Object({ analysis: Type.String() }),
  prompt: `分析当前上下文中的问题并给出思路。完成后调用 __graph_complete__ 提交，
result 格式为 { "analysis": "你的分析内容" }。`,
});

const 回答节点 = agentNode({
  subGoal: "给出最终答案",
  input: Type.Object({ analysis: Type.String() }),
  output: Type.Object({ answer: Type.String() }),
  prompt: `基于前面的分析给出简洁答案。完成后提交，
result 格式为 { "answer": "你的答案" }。`,
});

// ── 图定义 ──

export const 问答图 = defineGraph({
  id: "qa-demo",
  version: "1",
  goal: "分析问题并给出答案",

  input: Type.Object({ question: Type.String() }),
  output: Type.Object({ answer: Type.String() }),

  // 背景上下文：从 Graph Input 中选择哪些数据允许模型看到
  context: {
    background: {
      select: "all",
      render: ({ selected, meta }) =>
        `问题：${(selected as any)?.question ?? ""}`,
    },
    // 工作记忆：已完成阶段的结果对后续节点可见
    memory: { select: "all" },
  },

  entries: [entry("main", { to: "analyze" })],

  stages: {
    analyze: {
      node: 分析节点,
      route: firstMatch({
        next: connect("answer", {
          map: ({ completion }) => completion.result,
          frame: ({ completion }) => ({ stage: "analyze", analysis: completion.result.analysis }),
        }),
      }),
    },
    answer: {
      node: 回答节点,
      route: firstMatch({
        done: finish({
          output: ({ completion }) => completion.result,
        }),
      }),
    },
  },
});
```

四个关键概念：

- **图（Graph）**：整个任务流程，声明目标、输入输出契约、入口和阶段。
- **节点（Node）**：一个工作阶段。`agentNode` 让模型完成一个子目标，`codeNode` 运行确定代码，`graphNode` 调用子图。
- **连接（Connection）**：阶段完成后去哪，以及如何传递数据。
- **finish()**：图的终点。必须显式产生符合 output 契约的值。

## 4. 创建 extension 入口

创建 `src/my-extension.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { 问答图 } from "./my-graph.js";

export default function myExtension(pi: ExtensionAPI): void {
  const loop = createLoopGraphExtension(pi);

  // 注册到 Catalog（使其可被 GraphRef 引用）
  loop.registerGraph(问答图);

  // 暴露为 pi 命令：用户输入 /qa 触发
  loop.exposeGraph(
    { id: "qa-demo", version: "1" },
    {
      kind: "command",
      name: "qa",
      description: "分析问题并给出答案",
      parseInput: (args) => ({ question: args.trim() }),
    },
  );
}
```

两步分离：`registerGraph` 只让图可被发现，`exposeGraph` 再声明外部如何调用它（命令、工具或 API）。

## 5. 让 pi 加载

在项目 `.pi/config.json`：

```json
{
  "extensions": ["./src/my-extension.ts"]
}
```

## 6. 运行

启动 pi，输入：

```text
/qa 机器学习和深度学习的区别是什么？
```

运行顺序：

```text
命令参数 parseInput → { question: "机器学习和..." }
→ 入口选择（main Entry，guard 匹配）
→ "analyze" 阶段：Agent 分析问题
  → 模型看到：Graph goal + 问题背景 + 当前子目标
  → Agent 调用 __graph_complete__ 提交 { analysis: "..." }
  → Runtime 用 output 契约校验（Type.Object({ analysis: Type.String() })）
  → 校验通过
→ connect → "answer" 阶段：Agent 给出答案
  → 模型看到：Graph goal + 背景 + 已完成分析 + 当前子目标
  → Agent 提交 { answer: "..." }
→ finish → 图输出 { answer: "..." } → 返回给用户
```

如果校验失败（结果不匹配 output schema），Runtime 会拒绝并让 Agent 重试，最多 3 次。

## 7. 查看运行记录

运行结束后，replay JSON 自动保存在 `.loop-graph/runs/<runId>/replay.json`。通过 `/replay` 子路径生成 HTML：

```typescript
import { parseReplay, exportReplayHtml } from "pi-loop-graph-sdk/replay";
import { readFile, writeFile } from "node:fs/promises";

const json = await readFile(`.loop-graph/runs/${result.rootRunId}/replay.json`, "utf8");
const model = parseReplay(json);
await writeFile("report.html", exportReplayHtml(model), "utf8");
```

用浏览器打开 `report.html` 可以看到：

- **模型视角**：每个节点模型看到了什么上下文、产出了哪些内容
- **工具调用**：每次 `__graph_complete__` 的参数和 Runtime 判定
- **时间线**：全部事件的时间序列
- **原始事件**：完整 JSON 事件日志

## 下一步

- [理解图模型](concepts/graph-model.md) — 图、节点、路由的完整心智模型
- [构建条件路由与循环](guides/build-a-loop.md) — 根据结果走向不同阶段
- [调用子图](guides/call-subgraphs.md) — call、compose、delegate
- [自定义上下文](guides/customize-context.md) — 控制模型看到什么
- [添加验证](guides/automatic-validation.md) — output schema 与 Mechanism 验证
- [API 参考](reference/api.md) — 完整类型和工厂函数
