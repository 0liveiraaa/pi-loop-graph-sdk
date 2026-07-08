# Loop Graph — pi Agent 编排框架

Loop Graph 是一个基于 [pi](https://github.com/earendil-works/pi-mono) extension 的 agent 编排框架。它将 agent 工作流建模为**回路图（Graph）**——由节点（Node）、边（Edge）和路由策略（Router）组成的可执行有向图。

## 核心特性

- **帧栈折叠**——已完成节点的 ReAct 过程折叠为摘要帧，后续节点不看到历史展开细节
- **隔离栈**——子图创建独立 AgentInstance，帧栈从零开始，父图对子图不可见
- **不干预 ReAct**——框架只编排"什么时候跑什么节点"，不干涉节点内部的 LLM 推理
- **纯函数定制**——所有扩展点都是函数（`guard`、`migrate`、`execute`、`validateCompletion`）
- **可分发**——作为 pi package 发布，其它开发者可在自己的 extension 中导入使用

## 快速开始

### 安装

```bash
pi install git:github.com/your/loop-graph@v0.1
```

### 最小组装

```typescript
import { registerGraph, createAgentExecute, END } from "pi-loop-graph-extension";
import type { Graph, Node, Edge, Entry } from "pi-loop-graph-extension";

const greet: Node = {
  kind: "code",
  id: "greet",
  subGoal: "接收用户输入并复述",
  execute: createAgentExecute(),
};

const done: Edge = {
  id: "done",
  from: "greet",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(_instance, completion) {
    return { frame: { nodeId: completion.nodeId, status: completion.status, summary: "完成", result: completion.result } };
  },
};

export const graph: Graph = {
  id: "hello",
  goal: "问候",
  invocation: { name: "hello", description: "问候", inputSchema: {}, parseArgs: (a) => ({ args: a }) },
  entries: [{ id: "e", guard: () => true, startNodeId: "greet" }],
  nodes: { greet },
  routing: { greet: { nodeId: "greet", edges: [done], router: { kind: "first-match" } } },
};
```

在 extension 入口注册：

```typescript
import { registerGraph } from "pi-loop-graph-extension";
import { graph } from "./graph";

export default function (pi) {
  registerGraph(pi, graph);
}
```

输入 `/hello` 触发图运行。

## 项目结构

```
src/
├── type.ts                  # 核心类型
├── runtime.ts               # 运行时状态机
├── registry.ts              # 图注册表（公开 API）
├── router.ts                # 单边路由裁决
├── validate.ts              # 图校验
├── agent-execute.ts         # execute 工厂
├── adapter/
│   ├── extension.ts         # pi extension 入口
│   ├── projection.ts        # context 投影
│   ├── pi-node-context.ts   # Promise 桥接
│   ├── complete-tool.ts     # __graph_complete__
│   └── debug-log.ts         # 调试日志
└── graphs/                  # 测试图
```

## 文档

完整文档见 [`docs/`](docs/)：

| 文档 | 内容 |
|------|------|
| [CONTEXT](docs/%E8%AE%BE%E8%AE%A1/CONTEXT.md) | 术语表 |
| [核心设计](docs/%E8%AE%BE%E8%AE%A1/loop-graph-sdk-design.md) | 心智模型与关键设计决策 |
| [开发者指南](docs/%E8%AE%BE%E8%AE%A1/developer-guide.md) | SDK 使用指南 |
| [实现形态](docs/%E5%BD%A2%E6%80%81/implementation-status.md) | 当前实现状态 |

## License

MIT
