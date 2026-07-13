# 十分钟入门

本教程带你在十分钟内完成：安装 → 创建 extension → 定义一个节点 → 添加结束边 → 注册图 → 运行。

---

## 1. 安装

```bash
# 在你的 pi-agent 项目里
npm install git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1
```

你的 `package.json` 会自动添加依赖：

```json
{
  "dependencies": {
    "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1"
  }
}
```

---

## 2. 创建 Extension 入口

创建一个文件 `src/my-extension.ts`：

```typescript
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { myFirstGraph } from "./my-first-graph";

export default function myExtension(pi) {
  // 创建运行时实例
  const loop = createLoopGraphExtension(pi);
  // 注册图
  loop.registerGraph(myFirstGraph);
}
```

---

## 3. 定义一张图

创建 `src/my-first-graph.ts`，从 import 开始：

```typescript
import { createAgentExecute, END } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";
```

### 3.1 定义节点

节点是图里的一个工作步骤。这里定义两个节点：

**节点一：接收用户输入**

```typescript
const inputNode: Node = {
  kind: "code",
  id: "get_input",
  subGoal: "接收用户的消息",
  // createAgentExecute 创建一个让 LLM 执行的节点
  execute: createAgentExecute(),
};
```

`kind: "code"` 表示这个节点执行代码。`createAgentExecute()` 是工厂函数，它生成的 execute 函数会调用 LLM。执行时 agent 会看到 `subGoal` 作为任务指引。

**节点二：复述并结束**

```typescript
const echoNode: Node = {
  kind: "code",
  id: "echo",
  subGoal: "复述用户输入的内容，然后结束",
  execute: createAgentExecute(),
};
```

### 3.2 定义边

边连接节点，也连接节点到终点。终点用 `END` 表示。

```typescript
const inputToEcho: Edge = {
  id: "input_to_echo",
  from: "get_input",     // 从 inputNode
  to: "echo",             // 到 echoNode
  priority: 10,
  guard: (completion) => completion.status === "ok",
  migrate(instance, completion) {
    return {
      // frame 是送给下一个节点的历史摘要
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: "已接收用户输入",
        result: completion.result,
      },
      // input 是传给下一个节点的入参
      input: completion.result,
    };
  },
};

const echoToEnd: Edge = {
  id: "echo_to_end",
  from: "echo",
  to: END,                // 终点
  priority: 10,
  guard: (completion) => completion.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: "复述完成",
        result: completion.result,
      },
    };
  },
};
```

### 3.3 定义入口

入口告诉运行时什么条件下走这张图：

```typescript
const entry: Entry = {
  id: "main",
  guard: () => true,          // 任何入参都匹配
  startNodeId: "get_input",   // 第一个节点
};
```

### 3.4 组合为图

```typescript
export const myFirstGraph: Graph = {
  id: "my_first_graph",
  goal: "接收输入并复述",
  // invocation 声明这张图可以被用户通过 /echo 命令调用
  invocation: {
    name: "echo",
    description: "复述用户输入",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
    },
    // 用户输入 /echo 你好 → 转为 { message: "你好" }
    parseArgs: (args) => ({ message: args || "" }),
  },
  entries: [entry],
  nodes: {
    get_input: inputNode,
    echo: echoNode,
  },
  routing: {
    get_input: {
      nodeId: "get_input",
      edges: [inputToEcho],
      router: { kind: "first-match" },
    },
    echo: {
      nodeId: "echo",
      edges: [echoToEnd],
      router: { kind: "first-match" },
    },
  },
};
```

---

## 4. 完整的图文件

把上面的代码拼起来，`src/my-first-graph.ts` 完整内容：

```typescript
import { createAgentExecute, END } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";

const inputNode: Node = {
  kind: "code",
  id: "get_input",
  subGoal: "接收用户的消息",
  execute: createAgentExecute(),
};

const echoNode: Node = {
  kind: "code",
  id: "echo",
  subGoal: "复述用户输入的内容，然后结束",
  execute: createAgentExecute(),
};

const inputToEcho: Edge = {
  id: "input_to_echo",
  from: "get_input",
  to: "echo",
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: "已接收用户输入",
        result: completion.result,
      },
      input: completion.result,
    };
  },
};

const echoToEnd: Edge = {
  id: "echo_to_end",
  from: "echo",
  to: END,
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: "复述完成",
        result: completion.result,
      },
    };
  },
};

const entry: Entry = {
  id: "main",
  guard: () => true,
  startNodeId: "get_input",
};

export const myFirstGraph: Graph = {
  id: "my_first_graph",
  goal: "接收输入并复述",
  invocation: {
    name: "echo",
    description: "复述用户输入",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
    },
    parseArgs: (args) => ({ message: args || "" }),
  },
  entries: [entry],
  nodes: { get_input: inputNode, echo: echoNode },
  routing: {
    get_input: {
      nodeId: "get_input",
      edges: [inputToEcho],
      router: { kind: "first-match" },
    },
    echo: {
      nodeId: "echo",
      edges: [echoToEnd],
      router: { kind: "first-match" },
    },
  },
};
```

---

## 5. 配置 pi

在你的 pi 项目根目录创建或修改 `.pi/config.json`，指定 extension 入口：

```json
{
  "extensions": ["./src/my-extension.ts"]
}
```

---

## 6. 运行

启动 pi 后，输入命令：

```
/echo 你好，世界！
```

流程如下：

```
你输入 /echo 你好，世界！
  → 图开始执行
  → get_input 节点：agent 看到"接收用户的消息"
  → agent 调用 __graph_complete__({ status: "ok", result: { ... } })
  → inputToEcho 边：折叠帧，传递入参
  → echo 节点：agent 看到"复述用户输入的内容"
  → agent 复述并调用 __graph_complete__()
  → echoToEnd 边：折叠帧，走向 END
  → 图结束
```

---

## 7. 试试扩展

把两个节点改成三个：

```typescript
const nodes = {
  get_input: inputNode,
  review: {
    kind: "code",
    id: "review",
    subGoal: "检查用户输入是否合理，给出评价",
    execute: createAgentExecute(),
  },
  summarize: {
    kind: "code",
    id: "summarize",
    subGoal: "总结本次对话内容",
    execute: createAgentExecute(),
  },
};
```

再加一条边：`review → summarize → END`，并在 `routing` 里注册。不需要其他改动。

---

## 关键概念（只需记住三个）

| 概念 | 作用 |
|------|------|
| **Node（节点）** | 一个工作步骤。`kind: "code"` 可以调 LLM 或跑代码 |
| **Edge（边）** | 连接节点，决定什么时候走、怎么记住执行结果 |
| **END** | 图的终点，标记在哪结束 |

`Graph` 包含全部节点、边和入口。`invocation` 声明它对外叫什么名字（命令名）。

---

## 下一步

- [开发者指南](docs/形态/developer-guide.md) — 详尽的 API 参考
- [README](README.md) — 能力清单和项目概览
