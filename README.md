# Loop Graph SDK

面向 pi 的单 Agent、串行、可循环图编排 SDK。

> **版本状态：alpha。** 这是首个测试版本，API 仍可能调整。

Loop Graph SDK 让开发者用代码把复杂任务拆成明确阶段,将skill变为可调用的工作流。每个阶段可以运行普通代码、调用 Agent 或调用子图；阶段完成后，由显式路由决定下一步、保留哪些工作记忆以及是否形成循环。

## 适合什么

- 多阶段生成、检查、修改和再次检查；
- 代码处理与 Agent 推理混合的串行流程；
- 根据完成结果选择下一阶段或返回重试；
- 为不同节点声明工具，并增加工具门禁、自动验收和审计；
- 通过子图复用一组阶段，同时明确控制上下文共享边界。

## 核心能力

- **两类节点**：code node 执行代码或 Agent，graph node 调用子图。
- **条件路由和循环**：根据阶段完成结果选择边，也可以返回先前节点。
- **代码与 Agent 混合**：同一 code node 内可以准备数据、调用 Agent、再处理结果。
- **自动验证**：输出格式、自定义验证和外部可信验收可以阻止不合格结果放行。
- **工具控制**：节点声明可用工具，横切扩展可以拒绝、修改或脱敏工具调用。
- **上下文定制**：控制当前任务说明和已完成工作记忆如何呈现给 Agent。
- **三种子图边界**：call、compose 和 delegate 提供不同程度的共享与隔离。

## 安装

作为 library 依赖安装：

```bash
npm install git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1
```

如果只想体验 SDK 自带的测试图，也可以作为 pi extension 安装：

```bash
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
```

## 最小示例

下面是一张单节点图：接收 `/hello` 的参数，让 Agent 打招呼，然后通过 `END` 返回结果。

### 1. 定义图

创建 `hello-graph.ts`：

```typescript
import { END, createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";

const greetNode: Node = {
  kind: "code",
  id: "greet",
  subGoal: "根据用户提供的名字打招呼",
  execute: createAgentExecute({
    prompt: (input) =>
      `请用一句简短的话向 ${String(input.data.name ?? "世界")} 打招呼。`,
  }),
};

const done: Edge = {
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

const entry: Entry = {
  id: "main",
  guard: () => true,
  startNodeId: "greet",
  mapInput: (background) => ({
    name: String(background.name ?? "世界"),
  }),
};

export const helloGraph: Graph = {
  id: "hello_world",
  goal: "向用户指定的人打招呼",
  invocation: {
    name: "hello",
    description: "生成一句问候",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    parseArgs: (args) => ({ name: args.trim() || "世界" }),
  },
  entries: [entry],
  nodes: {
    greet: greetNode,
  },
  routing: {
    greet: {
      nodeId: "greet",
      edges: [done],
      router: { kind: "first-match" },
    },
  },
};
```

`frame` 是留给后续阶段的业务工作记忆，结构由图作者定义。`output` 明确声明整张图返回的状态和结果。

### 2. 注册到 pi extension

创建 `my-extension.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { helloGraph } from "./hello-graph.js";

export default function myExtension(pi: ExtensionAPI): void {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(helloGraph);
}
```

将这个入口加入你的 pi extension 配置，启动 pi 后运行：

```text
/hello 世界
```

完整的项目配置和执行过程见[十分钟快速开始](docs/getting-started.md)。

## 子图边界

| 边界         | 何时使用                                                           |
| ------------ | ------------------------------------------------------------------ |
| `call`     | 默认选择。复用当前执行会话，但子图使用新的逻辑工作实例和工作记忆。 |
| `compose`  | 子图必须读取父级工作记忆，或作为父节点的内部实现展开。             |
| `delegate` | 子任务需要独立执行会话和独立上下文生命周期。                       |

三种边界当前都会沿单一路径等待子图完成；delegate 不代表并行调度。

## 当前限制

- 同一图运行始终只推进一条节点路径，不支持 fork/join 并行分支。
- 不提供多个独立 Agent 之间的通讯和协作协议。
- 不提供进程或会话结束后的图运行恢复。
- 同一 `LoopGraphExtension` 实例不支持并发顶层执行。
- 当前是 alpha 版本；在生产使用前，应自行完成安全评估、故障处理和稳定性验证。

## 文档

| 目标                       | 入口                                      |
| -------------------------- | ----------------------------------------- |
| 完成第一个可运行 extension | [Getting Started](docs/getting-started.md) |
| 理解图、状态和子图边界     | [Concepts](docs/concepts/)                 |
| 按任务查找实现方法         | [Guides](docs/guides/)                     |
| 查询 API、配置和错误行为   | [API Reference](docs/reference/)           |
| 了解内部设计与维护约束     | [Design](docs/design/core-design.md)       |

## 开发检查

```bash
npm run build
npm test
npm run typecheck
```

默认不会写调试日志文件。只有显式设置 `debug: true` 时，SDK 才启用 JSONL 生命周期日志。

## License

MIT
