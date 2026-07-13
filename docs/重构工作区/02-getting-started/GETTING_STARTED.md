# 十分钟快速开始

这篇教程会创建一个最小 pi extension：用户输入 `/echo 你好`，一张只有一个节点的图让 Agent 复述消息，然后通过 `END` 返回结果。

## 1. 前置条件

你需要：

- Node.js 20 或更高版本；
- 一个能够加载 TypeScript extension 的 pi 环境；
- 一个 TypeScript 项目，并已安装 pi coding agent。

## 2. 安装 SDK

在你的 extension 项目中安装：

```bash
npm install git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1
```

## 3. 定义最小图

创建 `src/echo-graph.ts`：

```typescript
import { END, createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";

const echoNode: Node = {
  kind: "code",
  id: "echo",
  subGoal: "复述用户提供的消息",
  // Node.tools 是当前节点的工具声明；不要在 runAgent 中传 tools。
  tools: ["read"],
  execute: createAgentExecute({
    prompt: (input) => `请复述下面的消息：${String(input.data.message ?? "")}`,
  }),
};

const finish: Edge = {
  id: "finish",
  from: "echo",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return {
      // frame 是留给后续阶段的工作记忆，结构由业务自行定义。
      frame: {
        echoOutcome: completion.result,
      },
      // END 边用 output 明确声明整张图对外返回什么。
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
  startNodeId: "echo",
  mapInput: (background) => ({
    message: String(background.message ?? ""),
  }),
};

export const echoGraph: Graph = {
  id: "echo_graph",
  goal: "复述用户输入",
  invocation: {
    name: "echo",
    description: "复述一段消息",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
    parseArgs: (args) => ({ message: args.trim() }),
  },
  entries: [entry],
  nodes: {
    echo: echoNode,
  },
  routing: {
    echo: {
      nodeId: "echo",
      edges: [finish],
      router: { kind: "first-match" },
    },
  },
};
```

这里有四个关键部分：

- `Graph` 是整个任务流程。
- `Node` 是一个工作阶段。
- 节点完成后产生 Completion，也就是当前阶段的状态和结果。
- `Edge` 决定下一步去哪里，并保存需要留下的工作记忆。

`END` 是图的终点，不是一个节点。

## 4. 创建 extension 入口

创建 `src/my-extension.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { echoGraph } from "./echo-graph.js";

export default function myExtension(pi: ExtensionAPI): void {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(echoGraph);
}
```

## 5. 让 pi 加载 extension

在项目根目录的 `.pi/config.json` 中加入入口：

```json
{
  "extensions": ["./src/my-extension.ts"]
}
```

如果你的 pi 环境采用其他 extension 发现方式，请把同一个入口文件加入其 extension 配置。

## 6. 运行

启动 pi，然后输入：

```text
/echo 你好，世界！
```

运行顺序如下：

```text
命令参数变成 { message: "你好，世界！" }
→ Entry 为 echo 节点准备输入
→ echo 节点让 Agent 复述消息
→ Agent 调用 __graph_complete__ 提交阶段结果
→ finish 边保存工作记忆并通过 END 返回结果
```

如果图注册或工具校验失败，SDK 会在开始执行前给出错误。Agent 成功运行但返回 `failed` 时，应检查图的返回状态，而不只是捕获异常。

## 7. 扩成两个阶段

当你希望“先生成，再检查”时，可以增加第二个节点：

```typescript
const reviewNode: Node = {
  kind: "code",
  id: "review",
  subGoal: "检查复述是否保留了原意",
  tools: ["read"],
  execute: createAgentExecute({
    prompt: (input) =>
      `请检查下面的复述结果是否清楚且保留原意：${JSON.stringify(input.data.echoResult ?? {})}`,
  }),
};
```

把原来的 `echo → END` 改为两条迁移：

```text
echo → review → END
```

第一条边把数据显式交给 review：

```typescript
input: {
  echoResult: completion.result,
}
```

如果 review 不通过，可以再添加一条 `review → echo` 的条件边。这样形成的是跨阶段循环；什么时候返回修改、什么时候结束，都能从图上直接看见。

## 下一步

- [理解图、节点、边和状态](../03-concepts/concepts/graph-model.md)
- [构建条件路由与循环](../04-task-guides/guides/build-a-loop.md)
- [自动验证真实完成结果](../04-task-guides/guides/automatic-validation.md)
- [调用子图](../04-task-guides/guides/call-subgraphs.md)
- [公共 API 参考](../05-api-reference/reference/api.md)
