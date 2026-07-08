# Loop Graph SDK 开发者指南

## 概要

Loop Graph SDK 是一个基于 pi-extension 的 agent 编排框架。

**核心模型**：一个回路图（Graph）由节点（Node）、边（Edge）和路由策略（Router）组成。Agent 实例在图中流动——进入节点工作、结束后通过边迁移到下一节点、重复直到终点（END）。

**关键特性**：

- **帧栈折叠**：已完成节点的 ReAct 过程被折叠为摘要帧，后续节点只看到摘要，不看到原始展开过程
- **隔离栈**：子图创建独立的 AgentInstance，帧栈从零开始，父图的帧对子图不可见
- **不干预 ReAct**：框架只编排"什么时候跑什么节点"，不干涉节点内部的 LLM 推理循环
- **纯函数定制点**：所有定制都是函数（`guard`、`migrate`、`execute`、`validateCompletion`），无黑盒限制

---

## 快速开始

### 安装

```bash
npm install pi-loop-graph-extension
```

### 定义第一个图

```typescript
import { createAgentExecute } from "pi-loop-graph-extension";
import type { Edge, Entry, Graph, Node, NodeRouting } from "pi-loop-graph-extension";
import { END } from "pi-loop-graph-extension";

const greetNode: Node = {
  kind: "code",
  id: "greet",
  subGoal: "接收用户输入并复述",
  execute: createAgentExecute(),
};

const entry: Entry = {
  id: "main",
  guard: () => true,
  startNodeId: "greet",
};

const done: Edge = {
  id: "greet_done",
  from: "greet",
  to: END,
  priority: 10,
  guard: () => true,
  migrate(instance, completion) {
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

export const myGraph: Graph = {
  id: "hello_world",
  goal: "简单的问候图",
  invocation: {
    name: "hello",
    description: "问候测试",
    inputSchema: { type: "object", properties: { args: { type: "string" } } },
    parseArgs: (a) => ({ args: a || "世界" }),
  },
  entries: [entry],
  nodes: { greet: greetNode },
  routing: {
    greet: { nodeId: "greet", edges: [done], router: { kind: "first-match" } },
  },
};
```

### 注册到 extension

```typescript
// 在 extension.ts 里
import { myGraph } from "./graphs/my-graph";
registerGraph(pi, myGraph);
```

用户输入 `/hello` 触发图运行。

---

## 核心概念

### Graph（回路图）

```typescript
interface Graph {
  id: string;                            // 唯一标识
  goal: string;                          // 图的总目标
  invocation?: GraphInvocation;          // 对外接口（命令名、描述、参数 schema）
  entries: Entry[];                      // 入口列表
  nodes: Record<string, Node>;           // 节点集合
  routing: Record<string, NodeRouting>;  // 每个节点的路由配置
}
```

- 有 `invocation` → 对用户可见，自动注册为 pi 命令和工具
- 无 `invocation` → 纯子图，只能被别的节点引用

### Entry（入口）

```typescript
interface Entry {
  id: string;
  guard(background: Record<string, unknown>): boolean;  // 匹配条件
  startNodeId: string;                                    // 第一个节点
  mapInput?(background: Record<string, unknown>): Record<string, unknown>;  // 可选：转换输入
}
```

`guard` 决定"什么情况下走这个入口"。多入口通过 guard 区分。

### Node（节点）

两种形态，互斥：

```typescript
type Node =
  | {
      kind: "code";
      id: string;
      subGoal: string;
      skill?: string;                                     // 关联 skill
      tools?: string[];                                   // 工具白名单
      mechanisms?: Mechanism[];
      execute(instance, input, ctx): Promise<NodeCompletion>;  // 总是调用
      validateCompletion?: (result) => { isValid, reason };    // 可选验证
    }
  | {
      kind: "graph";
      id: string;
      subGoal: string;
      graph: Graph;                                       // 引用的子图
    };
```

| 节点类型                        | execute                       | 引擎行为                                  |
| ------------------------------- | ----------------------------- | ----------------------------------------- |
| `kind: "code"` 有 skill/tools | `createAgentExecute()` 工厂 | 调 execute → 内部调 runAgent → LLM 推理 |
| `kind: "code"` 纯逻辑         | 自定义函数                    | 调 execute → 直接返回 NodeCompletion     |
| `kind: "graph"`               | 不提供                        | 创建子 Runtime 委托子图                   |

### Edge（边）

```typescript
interface Edge {
  id: string;
  from: string;
  to: string | typeof END;
  priority: number;
  guard(completion: NodeCompletion): boolean;         // 条件
  migrate(instance, completion): MigrationResult;      // 折叠栈帧 + 生成后继输入
}
```

| 部分        | 作用                                                                           |
| ----------- | ------------------------------------------------------------------------------ |
| `guard`   | 读`NodeCompletion`，判断是否走这条边                                         |
| `migrate` | 把 completion 折叠为`ContextFrame`（推入帧栈），可选生成下一节点的 `input` |
| `to`      | 目标节点，`END` 为终止标记                                                   |

### Router（路由策略）

```typescript
type RouterStrategy =
  | { kind: "first-match" }         // 按 edges 顺序取第一条满足 guard 的
  | { kind: "priority-first" }      // 取 priority 最高者
  | { kind: "custom"; fn: RouterFn } // 自定义函数
  | { kind: "agent-choice" };       // 未实现（可用 custom 替代）
```

---

## 创建节点

### Agent 节点（声明式）

推荐用 `createAgentExecute` 工厂：

```typescript
import { createAgentExecute } from "pi-loop-graph-extension";

const myNode: Node = {
  kind: "code",
  id: "grade",
  subGoal: "批改用户答案",
  execute: createAgentExecute({
    skill: "review-grade",
    tools: ["review_answer"],
  }),
};
```

工厂函数内部调 `ctx.runAgent()`，触发 LLM 推理。节点完成后 LLM 必须调用 `__graph_complete__` 工具上报结果。

### Agent 节点（自定义 prompt）

```typescript
execute: createAgentExecute({
  prompt: (input) => `请批改以下答案：\n${input.data.user_answer}`,
  skill: "review-grade",
  tools: ["review_answer"],
}),
```

### Agent 节点 + 完成度验证

```typescript
execute: createAgentExecute({
  skill: "review-grade",
  tools: ["review_answer"],
  validateCompletion(result) {
    if (!result.score) return { isValid: false, reason: "缺少 score" };
    if (typeof result.score !== "number") return { isValid: false, reason: "score 应为数字" };
    return { isValid: true };
  },
}),
```

验证不通过时，引擎会自动注入一条重试消息让 LLM 继续工作。

### 纯代码节点（无 LLM）

纯代码节点的 `execute` 就是普通 async 函数，可以直接使用 Node.js 或任何库：

```typescript
import fs from "node:fs";

const readFileNode: Node = {
  kind: "code",
  id: "read",
  subGoal: "读取文件内容",
  execute: async (_instance, input, _ctx) => {
    const path = input.data.path as string;
    const content = fs.readFileSync(path, "utf-8");
    return {
      nodeId: "read",
      status: "ok",
      result: { path, content, lineCount: content.split("\n").length },
    };
  },
};

const apiCaller: Node = {
  kind: "code",
  id: "fetch",
  subGoal: "调外部 API",
  execute: async (_instance, input, _ctx) => {
    const res = await fetch(input.data.url as string);
    const json = await res.json() as Record<string, unknown>;
    return { nodeId: "fetch", status: "ok", result: json };
  },
};
```

**原则**：`execute` 就是一个 JavaScript 异步函数。
不需要 `callTool`，不需要 pi 的工具系统，不需要 LLM。
传入 `input.data`，产出 `NodeCompletion`。
如果某个操作纯代码做不了，就交给 agent 节点（`createAgentExecute` 工厂）去调 LLM。

```typescript
// 示例：纯校验节点
const validateNode: Node = {
  kind: "code",
  id: "validate_input",
  subGoal: "校验用户输入",
  execute: async (_instance, input, _ctx) => {
    const name = input.data.name;
    if (!name || typeof name !== "string") {
      return { nodeId: "validate_input", status: "failed", result: { reason: "name 无效" } };
    }
    return { nodeId: "validate_input", status: "ok", result: { name, valid: true } };
  },
};

### 复合节点（子图）

```typescript
const subGraph: Node = {
  kind: "graph",
  id: "sub_process",
  subGoal: "委托子图处理",
  graph: mySubGraph,  // 另一个 Graph 对象
};
```

---

## 边和路由

### 基础用法

```typescript
const okEdge: Edge = {
  id: "to_next",
  from: "grade",
  to: "summary",
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `得分: ${completion.result.score}`,
        result: completion.result,
      },
      input: { score: completion.result.score },
    };
  },
};

const failedEdge: Edge = {
  id: "to_retry",
  from: "grade",
  to: "grade",               // 自环：重回本节点
  priority: 5,
  guard: (c) => c.status === "failed",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: "ok",
        summary: "用户答错，准备重试",
        result: completion.result,
      },
      input: { retry: true },
    };
  },
};
```

```typescript
routing: {
  grade: {
    nodeId: "grade",
    edges: [failedEdge, okEdge],  // 先匹配失败边，再匹配成功边
    router: { kind: "priority-first" },  // 按 priority 排序，同级按数组顺序
  },
},
```

### 无边匹配

当 `selectEdge` 找不到满足 `guard` 的边时，图会优雅结束（不 throw），推入一帧标记失败原因。

### agent-choice

当前 `{ kind: "agent-choice" }` 会抛异常。如果你需要让 LLM 选边，可以用 `custom` 自己实现——注册一个临时工具，把可选路由列表呈现给 LLM，由 LLM 的返回决定走哪条边。

---

## 完成度验证

节点声明 `validateCompletion` 函数，引擎在 `__graph_complete__` 调用时自动执行：

```typescript
validateCompletion(result) {
  if (!result.question) return { isValid: false, reason: "缺少 question" };
  if (!result.options || result.options.length < 2)
    return { isValid: false, reason: "选项应至少 2 个" };
  return { isValid: true };
}
```

**流程**：

1. LLM 调 `__graph_complete__({ status: "ok", result: { question: "1+1=?", options: ["2"] } })`
2. 验证发现 `options.length < 2` → 不通过
3. 引擎自动注入一条消息："验证未通过: 选项应至少 2 个。请修正后再次调用 __graph_complete__"
4. LLM 收到后补充选项，再次上报
5. 验证通过 → 路由 → 下一节点

**注意**：验证只在 `completion.status === "ok"` 时执行。`failed` 和 `cancelled` 不验证，直接进入路由。

---

## 子图

子图使用隔离栈：创建新的 `AgentInstance`，`frames = []`，`background` 来自调用点的 `NodeInput.data`。

```typescript
const childGraph: Graph = {
  id: "child",
  goal: "子任务",
  entries: [entry],
  nodes: { step1, step2 },
  routing: { ... },
};

// 父图中引用：
const graphNode: Node = {
  kind: "graph",
  id: "invoke_child",
  subGoal: "委托子图处理",
  graph: childGraph,
};
```

**隔离保证**：

- 子图运行时，父图的帧栈对其不可见
- 子图结束后归约为一帧，包含子图内部帧和最终结果
- 父图路由决定这一帧怎么折叠进父图帧栈

---

## 帧栈与投影

### 帧栈是什么

`AgentInstance.frames` 是一个数组，按时间顺序存储已折叠的节点执行历史。每个 `ContextFrame`：

```typescript
interface ContextFrame {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  summary: string;
  result: Record<string, unknown>;
}
```

### 投影是什么

每次 LLM 调用前，`context` 钩子将当前消息切分为三段：

```
=== COMPLETED === ← 帧栈摘要（已完成节点的折叠结果）
=== CURRENT ===   ← 当前节点信息（subGoal、输入、工具）
（当前节点的 live ReAct 消息）
```

已完成节点的原始 ReAct 不在发送给 LLM 的上下文中。

### 什么时候推帧

`Edge.migrate` 返回的 `frame` 被推入帧栈。开发者通过 `migrate` 控制每帧的 `summary` 和 `result`：

```typescript
migrate(instance, completion) {
  return {
    frame: {
      nodeId: "generate_question",
      status: "ok",
      summary: `已生成题目 ${completion.result.question_id}`,
      result: completion.result,
    },
  };
}
```

`summary` 只允许纯字符串（框架不调用 LLM 优化）。如果需要自然语言摘要，开发者自己决定在 migrator 中调用 LLM。

---

## NodeCompletion

```typescript
interface NodeCompletion {
  nodeId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
}
```

| 字段       | 说明                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `nodeId` | 当前节点 ID                                                                |
| `status` | 完成状态                                                                   |
| `result` | 产出的结构化数据。`Record<string, unknown>` 不做类型约束，开发者自行保证 |

---

## 入参体系

### NodeInput

```typescript
interface NodeInput {
  data: Record<string, unknown>;    // 当前节点的一次性入参
  source: "entry" | "edge";        // 来源
}
```

### 节点间传递

```
Edge.migrate 的 input 字段 → 下一节点的 NodeInput.data
```

`input` 只传递给直接后继节点。如果后续节点需要某些信息，必须在 `result` 中产出，经 `Edge.migrate` 折叠进帧。

---

## 调试

运行后项目根目录生成 `loop-graph-debug.log`（JSONL 格式）：

```bash
tail -f loop-graph-debug.log  # 实时观察
```

关键事件：

| 事件               | 查看内容                     |
| ------------------ | ---------------------------- |
| `enter_node`     | 节点 ID、输入数据、当前帧栈  |
| `projection`     | 消息总数、哨兵是否命中、帧数 |
| `agent_complete` | 完成状态、result 字段列表    |
| `exit_node`      | 推入的帧摘要、累计帧数       |
| `agent_retry`    | 验证不通过的原因             |

---

## 完整示例

一个两节点复习图：选择科目 → 生成题目 → END。

```typescript
import { END, createAgentExecute } from "pi-loop-graph-extension";
import type { Edge, Entry, Graph, Node, NodeCompletion, NodeRouting } from "pi-loop-graph-extension";

// ── 节点 ──

const selectNode: Node = {
  kind: "code",
  id: "select_target",
  subGoal: "选择科目和模式",
  tools: ["review_chapter", "review_exam_points"],
  execute: createAgentExecute({ tools: ["review_chapter", "review_exam_points"] }),
};

const questionNode: Node = {
  kind: "code",
  id: "generate_question",
  subGoal: "生成一道符合约束的结构化题目",
  skill: "review-question",
  tools: ["review_card"],
  execute: createAgentExecute({ skill: "review-question", tools: ["review_card"] }),
  validateCompletion(result) {
    if (!result.question_text) return { isValid: false, reason: "缺少 question_text" };
    if (!result.options || result.options.length < 2) return { isValid: false, reason: "选项应至少 2 个" };
    return { isValid: true };
  },
};

// ── 边 ──

const selectToQuestion: Edge = {
  id: "sel_to_q",
  from: "select_target",
  to: "generate_question",
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `已选择: ${completion.result.subject} / ${completion.result.mode}`,
        result: completion.result,
      },
      input: { subject: completion.result.subject, mode: completion.result.mode },
    };
  },
};

const questionDone: Edge = {
  id: "q_to_end",
  from: "generate_question",
  to: END,
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `已生成题目: ${completion.result.question_text?.slice(0, 40)}`,
        result: completion.result,
      },
    };
  },
};

// ── 入口 ──

const entry: Entry = {
  id: "review_cmd",
  guard: (bg) => !!(bg as any).args,
  startNodeId: "select_target",
  mapInput: (bg) => ({ subject: (bg as any).args || "" }),
};

// ── 图 ──

export const reviewGraph: Graph = {
  id: "quick_review",
  goal: "快速生成复习题目",
  invocation: {
    name: "r",
    description: "快速复习",
    inputSchema: { type: "object", properties: { args: { type: "string" } } },
    parseArgs: (a) => ({ args: a }),
  },
  entries: [entry],
  nodes: { select_target: selectNode, generate_question: questionNode },
  routing: {
    select_target: {
      nodeId: "select_target",
      edges: [selectToQuestion],
      router: { kind: "first-match" },
    },
    generate_question: {
      nodeId: "generate_question",
      edges: [questionDone],
      router: { kind: "first-match" },
    },
  },
};
```

---

## 限制

| 项                    | 说明                                     |
| --------------------- | ---------------------------------------- |
| `agent-choice` 路由 | 未实现，可用`custom` 替代              |
| `callTool`          | 未实现，纯代码节点可直接 import pi 工具  |
| session 续跑          | 当前不持久化帧栈，图运行中断后需重新开始 |
| 声明式编译器          | 暂不开发，所有定制点为函数               |
