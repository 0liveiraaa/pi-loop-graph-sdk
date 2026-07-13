# Loop Graph SDK — 基于 pi 的 Agent 编排框架

> **版本状态**：首个测试版本（alpha）。API 可能调整，不承诺生产稳定。

Loop Graph SDK 是一个基于 [pi](https://github.com/earendil-works/pi-mono) 的**单 Agent 串行图编排框架**，将多步骤 agent 工作流建模为可执行的回路图。

---

## 当前定位

本 SDK **只做一件事**：让开发者用代码定义一张有向图，agent 按图一步步执行，每步可以调 LLM、跑代码或调用子图。

适合需要明确阶段、条件路由和循环返工的**串行多步骤**任务：复习助手、文档审查、代码审查、数据流水线等。

---

## 最小可运行示例

以下是一个两节点图：接收输入 → 复述 → 结束。**复制后即可运行。**

### 1. 定义图

```typescript
// hello-graph.ts
import { createAgentExecute, END } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";

// 节点：接收用户输入并复述
const greetNode: Node = {
  kind: "code",
  id: "greet",
  subGoal: "接收用户输入并复述",
  execute: createAgentExecute(),
};

// 边：完成后结束
const doneEdge: Edge = {
  id: "done",
  from: "greet",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      frame: {
        greetingOutcome: completion.result,
      },
      output: {
        status: completion.status,
        result: completion.result,
      },
    };
  },
};

// 入口
const entry: Entry = {
  id: "main",
  guard: () => true,
  startNodeId: "greet",
};

// 导出图定义
export const helloGraph: Graph = {
  id: "hello_world",
  goal: "简单的问候图",
  invocation: {
    name: "hello",
    description: "问候测试",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    parseArgs: (a) => ({ name: a || "世界" }),
  },
  entries: [entry],
  nodes: { greet: greetNode },
  routing: {
    greet: {
      nodeId: "greet",
      edges: [doneEdge],
      router: { kind: "first-match" },
    },
  },
};
```

### 2. 注册到 pi extension

```typescript
// my-extension.ts
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { helloGraph } from "./hello-graph";

export default function myExtension(pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(helloGraph);
}
```

### 3. 运行

```bash
# pi 中直接调用
/hello 世界
# → agent 复述：你好，世界！
```

---

## 核心能力

- **节点**：`code` 节点（LLM 推理 + 任意 JavaScript）和 `graph` 节点（引用子图）。
- **条件路由**：根据节点完成状态选择不同后继，支持自环形成重试和循环。
- **子图调用**：`call`（独立工作区）、`compose`（共享工作记忆）、`delegate`（独立会话）三种边界。
- **代码与 Agent 混合**：同一节点内可以准备数据、调用 LLM、处理结果，自由穿插。
- **自动验证**：声明输出格式或编写校验函数，LLM 结果不符合时自动驳回重试。
- **横切扩展（Mechanism）**：工具门禁、结果脱敏、外部验收、审计日志，在节点生命周期中按需挂载。
- **上下文定制**：自定义 LLM 看到的当前任务描述和历史工作记忆格式。

详细文档见下方「下一步」的导航链接。


---

## 安装

```bash
# 作为 library 依赖（推荐用于业务项目）
npm install git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1
# 或在 package.json 中添加：
# "dependencies": { "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1" }

# 作为 pi 扩展安装（用于快速体验 SDK 自带测试图）
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
```

## 测试

```bash
git clone https://github.com/0liveiraaa/pi-loop-graph-sdk
cd pi-loop-graph-sdk
npm install
npm test -- --run    # 运行全部测试
npx tsc --noEmit     # 类型检查
```

SDK 默认不写调试日志文件。开发调试时可在创建扩展实例时显式开启：

```typescript
const loop = createLoopGraphExtension(pi, {
  debug: true,
  debugLogPath: "loop-graph-debug.log",
});
```

---

## 下一步

| 目标                     | 入口                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| **十分钟快速开始** | [docs/getting-started/](../02-getting-started/)                                           |
| **理解核心概念**   | [docs/concepts/](../03-concepts/concepts/)                                                |
| **按任务查阅指南** | [docs/guides/](../04-task-guides/guides/)                                                 |
| **公共 API 参考**  | [docs/reference/](../05-api-reference/reference/)                                         |
| **核心设计文档**   | [docs/design/](../06-design-and-internals/draft/core-design.md)                           |
| **真实用例**       | [pi-review-agent](https://github.com/0liveiraaa/pi-review-agent)（基于本 SDK 的复习助手） |

## License

MIT
