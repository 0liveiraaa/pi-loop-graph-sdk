# Loop Graph SDK — 基于 pi 的 Agent 编排框架

Loop Graph SDK 是一个基于 [pi](https://github.com/earendil-works/pi-mono) 的**单 Agent 串行图编排框架**，将多步骤 agent 工作流建模为可执行的回路图。

---

## 当前定位

本 SDK **只做一件事**：让开发者用代码定义一张有向图，agent 按图一步步执行，每步可以调 LLM、跑代码或调用子图。

它适用于所有**串行多步骤**场景：复习助手、文档审查、代码审查、数据流水线等。


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
        nodeId: completion.nodeId,
        status: completion.status,
        summary: "问候完成",
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

## 当前能力

### 图定义

| 能力           | 说明                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| **节点** | `code` 节点（LLM 推理 + 任意 JavaScript）和 `graph` 节点（引用子图） |
| **边**   | 条件守卫（`guard`）+ 历史折叠（`migrate`）+ 目标指向                 |
| **路由** | 优先级优先、首匹配、Agent 自主选择、自定义函数                           |
| **入口** | 多入口，按入参条件匹配                                                   |
| **出口** | `END` 标记终止，可声明对外返回结果                                     |

### 节点执行

| 能力               | 说明                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| **LLM 推理** | `createAgentExecute()` 工厂，可选 skill、prompt 模板、输出 schema         |
| **纯代码**   | execute 内可直接使用任意 Node.js API（fs、fetch、child_process）            |
| **混合**     | 一次 execute 内多次调用`runAgent()` 与代码穿插                            |
| **完成验证** | 输出 schema 校验 → 自定义 validateCompletion → Mechanism gate → 路由校验 |

### 子图组合

| 方式         | 隔离级别                           | 适用场景               |
| ------------ | ---------------------------------- | ---------------------- |
| `call`     | 独立工作区（历史不可见）           | 通用子任务             |
| `compose`  | 共享工作区（历史可见，退出时压缩） | 以图代点的代码组织     |
| `delegate` | 完全隔离的独立对话                 | 长任务、独立上下文管理 |

### 横切能力

| 能力                       | 说明                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| **节点生命周期钩子** | `onNodeEnter`（进入前）、`onNodeExit`（完成后）、`onNodeError`（出错时）    |
| **作用域生命周期**   | 每次节点执行获得独立 scope，包含取消信号、活跃检查、自动清理                      |
| **失败策略**         | `continue`（继续）、`fail-node`（标记节点失败）、`fail-graph`（终止整张图） |
| **私有状态**         | 按工作区 + 机制身份隔离，跨节点访问保留，不入 LLM 上下文                          |
| **工具决策**         | 允许/拒绝/修改工具参数，按机制顺序组合，自动重验参数                              |
| **完成验收**         | 异步 Gate 支持 allow/reject/fail-node/fail-graph，可信结果与 AI 结果分离          |
| **事件订阅**         | `onToolResult`、`onTurnStart`、`onTurnEnd`，作用域关闭时自动取消            |
| **外部命令**         | `exec.run()` 绑定取消信号、超时、工作目录和输出限制                             |

### 上下文定制

| 能力                   | 说明                                              |
| ---------------------- | ------------------------------------------------- |
| **节点指引渲染** | `contextRenderer` 自定义 LLM 看到的当前任务描述 |
| **历史摘要格式** | `frameFormatter` 自定义已完成节点的展示格式     |
| **Skill 加载**   | 异步 provider、自定义 renderer、缺失/错误策略     |
| **LLM 消息文案** | 重试提示、恢复消息、完成消息均可定制              |

### 运行控制

| 能力                 | 说明                                                  |
| -------------------- | ----------------------------------------------------- |
| **步骤上限**   | `rootMaxSteps`（顶层图）、`childMaxSteps`（子图） |
| **超时控制**   | `agentRunTimeoutMs` 单次 LLM 推理超时               |
| **并发保护**   | 同一实例不允许并发顶层调用                            |
| **debug 日志** | 自动生成 JSONL 日志文件                               |

---

## 明确不支持的能力

以下能力**不在当前范围内**，也不会在短期内添加：

| 能力                           | 原因                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| **多 Agent 并行/通信**   | SDK 定位于单 Agent 串行编排。多 Agent 需要独立的通信协议和调度层 |
| **Session 持久化**       | 所有状态存在于内存中。需要持久化的项目应自行实现存储层           |
| **图拓扑的运行时热更新** | 图在注册期固化。运行时修改需要重新注册                           |
| **fork/join 并行节点**   | 单 Agent 串行模型不支持同时进入多条后继边                        |

---

## 安装

```bash
# 作为 pi 扩展安装（用于测试和体验）
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1

# 作为 library 依赖（推荐用于业务项目）
npm install git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1
# 或在 package.json 中添加：
# "dependencies": { "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1" }
```

## 测试

```bash
git clone https://github.com/0liveiraaa/pi-loop-graph-sdk
cd pi-loop-graph-sdk
npm install
npm test -- --run
```

当前 277 项测试（14 个测试文件），包含真实 LLM 调用验证。

```bash
# 类型检查
npx tsc --noEmit
```

## 文件结构

```
src/
├── index.ts                       # 公开 API 导出入口
├── type.ts                        # 核心类型定义
│                                  # （Graph, Node, Edge, Entry, Router,
│                                  #  Mechanism, AgentInstance, ...）
├── runtime.ts                     # 运行时状态机（帧栈管理）
├── registry.ts                    # 图注册表
├── router.ts                      # 路由选择
├── validate.ts                    # 图结构与工具校验
├── agent-execute.ts               # execute 工厂函数
├── tools-resolve.ts               # 工具列表合并与去重
├── adapter/
│   ├── loop-graph-extension.ts    # ★ 运行时工厂 createLoopGraphExtension()
│   ├── mechanism-runtime.ts       #   Mechanism 生命周期、事件总线、状态管理
│   ├── pi-node-context.ts         #   LLM 调用桥接（Promise + 验证）
│   ├── complete-tool.ts           #   完成工具 __graph_complete__
│   ├── projection.ts              #   上下文消息组装
│   ├── model-messages.ts          #   LLM 消息文案定制
│   ├── skill-content.ts           #   Skill 异步加载与渲染
│   ├── graph-execution-host.ts    #   隔离执行宿主（delegate）
│   ├── isolated-graph-session.ts  #   隔离会话工厂
│   └── debug-log.ts               #   调试日志
├── graphs/                        # 内置测试图
│   ├── review-graph.ts
│   ├── chain-graph.ts
│   ├── subgraph-graph.ts
│   └── ...
docs/
├── 设计/CONTEXT.md                # 术语表
├── 设计/loop-graph-sdk-design.md  # 设计文档
├── 形态/developer-guide.md        # 开发者指南
├── 形态/implementation-status.md  # 实现状态
└── adr/                           # 架构决策记录
```

## 下一步

| 目标                    | 入口                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| **理解核心概念**  | [术语表](docs/设计/CONTEXT.md)                                                            |
| **阅读设计理念**  | [设计文档](docs/设计/loop-graph-sdk-design.md)                                            |
| **学习 SDk 使用** | [开发者指南](docs/形态/developer-guide.md)                                                |
| **查看实现状态**  | [实现形态](docs/形态/implementation-status.md)                                            |
| **架构决策**      | [ADR 目录](docs/adr/)                                                                     |
| **真实用例**      | [pi-review-agent](https://github.com/0liveiraaa/pi-review-agent)（基于本 SDK 的复习助手） |

## License

MIT
