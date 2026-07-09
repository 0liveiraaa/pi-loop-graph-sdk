# Loop Graph SDK 开发者指南

## 概要

Loop Graph SDK 是一个基于 pi-extension 的 agent 编排框架。

**核心模型**：一个回路图（Graph）由节点（Node）、边（Edge）和路由策略（Router）组成。Agent 实例在图中流动——进入节点工作、结束后通过边迁移到下一节点、重复直到终点（END）。

**关键特性**：

- **帧栈折叠**：已完成节点的 ReAct 过程被折叠为摘要帧，后续节点只看到摘要，不看到原始展开过程
- **隔离栈**：子图创建独立的 AgentInstance，帧栈从零开始，父图的帧对子图不可见
- **不干预 ReAct**：框架只编排"什么时候跑什么节点"，不干涉节点内部的 LLM 推理循环
- **全员函数扩展**：所有定制点都是函数（`guard`、`migrate`、`execute`、`validateCompletion`、`custom router`），无黑盒限制
- **框架不引入全局隐式状态**：所有跨节点数据流经帧栈显式传递，不依赖闭包或模块变量
- **框架不修改 system prompt**：所有上下文操作在消息流追加侧进行，不破坏 pi 原生 prompt 管理

---

## 两种使用方式

### 方式 A：作为 debug/demo pi extension 使用

```bash
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
```

这会加载 SDK 自带 debug extension（`./extension`），注册测试图（`/echo-test`、`/probe`、`/chain`、`/sub`、`/validate-test`）。用于验证 SDK 是否正常工作、探索图机制。

**注意**：`pi install` 并列安装不等于其它 pi package 可以直接导入 SDK。如果需要以 library 形式使用，请看方式 B。

### 方式 B：作为业务 extension 的 library 依赖

业务 package 在自己的 `package.json` 中声明依赖：

```json
{
  "dependencies": {
    "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1"
  }
}
```

然后创建独立运行时并注册图：

```typescript
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { myGraph } from "./graphs/my-graph";

export default function myExtension(pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(myGraph);
}
```

**关键区别**：

- 方式 A：SDK 自带的 debug extension 入口，等价于 `createLoopGraphExtension(pi, { demoGraphs: true })`
- 方式 B：业务代码导入 library API，创建自己的运行时实例，demo graphs 不注册

### 运行时工厂选项

`createLoopGraphExtension(pi, options?)` 支持以下选项：

```typescript
interface LoopGraphExtensionOptions {
  /** 是否注册 SDK 自带测试图。默认 false。只有 debug extension 入口设为 true。 */
  demoGraphs?: boolean;
  /** 所有节点默认可用的工具列表。为空时只保留 read + __graph_complete__。
   *  例如业务包可传入 ["review_card", "review_chapter"] 作为全局工具。
   *  注意：工具集最终由 resolveNodeTools(defaultTools, node.tools) 合并并去重。 */
  defaultTools?: string[];
  /** skill 目录的根路径。node.skill 的 SKILL.md 在此路径下按 {name}/SKILL.md 查找。
   *  默认 process.cwd() + "/skills"。参见 §skill 集成。 */
  skillBasePath?: string;
}
```

`defaultTools` 在注册期通过 `resolveNodeTools` 与每个节点的 `tools` 合并并去重：

```text
最终工具集 = read + defaultTools ∪ node.tools + __graph_complete__（去重，read 强制首位）
```

这样业务包不需要在每个节点重复声明全局可用工具。

---

## 快速开始

### 定义第一个图

```typescript
import { createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";
import { END } from "pi-loop-graph-sdk";

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
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    // parseArgs 将 /hello 世界 → { name: "世界" }
    parseArgs: (a) => ({ name: a || "世界" }),
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
// 在 extension 入口
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { myGraph } from "./graphs/my-graph";

export default function myExtension(pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(myGraph);
}
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
  mechanisms?: Mechanism[];              // 全局横切机制，跨节点生效
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

### Mechanism（横切机制）

Mechanism 是**代码侧 hooks 的注册入口**。框架在节点进入后自动调用 `onNodeEnter`，机制在里面注册 pi 原生事件——这些事件在 agent 运行期间持续触发。

```typescript
interface MechanismContext {
  pi: ExtensionAPI;                              // 全部 pi 能力
  instance: AgentInstance;                       // 当前实例（scratch 可写）
  node: Node;                                    // 当前节点
  input: NodeInput;                              // 代码侧入参
  appendContext(content: string): void;           // 向 agent 消息流追加
}

interface Mechanism {
  name: string;
  onNodeEnter?(ctx: MechanismContext): Promise<void>;
}
```

执行顺序：

```text
enterNode → Graph.mechanisms.onNodeEnter → Node.mechanisms.onNodeEnter → execute
```

规则：

- 全局机制写在 `Graph.mechanisms`，跨节点持续生效。
- 局部机制写在 `Node.mechanisms`，只在当前节点叠加。
- `onNodeEnter` 串行 await；抛错记日志后继续，不中止节点。
- 未定义 `onNodeEnter` 的 mechanism 被跳过。

两个合法作用通道：

| 通道 | 作用 | 是否进入 agent 上下文 | 生命周期 |
|------|------|------------------------|----------|
| `ctx.instance.scratch` | 代码侧横切状态（计时、计数、预处理结果） | 否 | 当前 AgentInstance；子图独立 |
| `ctx.appendContext(content)` | 向 agent 消息流追加内容 | 是，追加到当前节点 active 段 | 当前节点；离开后随 ReAct 折叠 |

通过 `ctx.pi.on()` 注册 pi 原生事件，可以 hook 到 agent 运行期间的每一拍：

| 需要 hook 的时刻 | 注册哪个 pi 事件 |
|-----------------|-----------------|
| 工具调用后 | `tool_result` |
| 每轮 LLM 请求前 | `before_provider_request` |
| LLM 响应后 | `after_provider_response` |
| 每轮开始 | `turn_start` |
| 每轮结束 | `turn_end` |
| 消息追加后 | `message_end` |

> **注意**：pi 没有 `off`。事件回调需自限——读 `ctx.instance.scratch` 或 `ctx.node.id` 判断是否仍在当前节点，条件不满足时 early return。

示例：计时 + 工具审计 + 动态上下文：

```typescript
const timingMechanism: Mechanism = {
  name: "timing",
  async onNodeEnter(ctx) {
    ctx.instance.scratch[`${ctx.node.id}_started`] = Date.now();
  },
};

const toolAuditor: Mechanism = {
  name: "tool-auditor",
  async onNodeEnter(ctx) {
    const nodeId = ctx.node.id;
    ctx.pi.on("tool_result", (event) => {
      if (ctx.instance.scratch._done) return;
      auditLog.write({ nodeId, tool: event.toolName });
    });
  },
};

const autoTest: Mechanism = {
  name: "auto-test",
  async onNodeEnter(ctx) {
    ctx.pi.on("tool_result", (event) => {
      if (event.toolName !== "bash") return;
      const cmd = (event.details as any)?.command ?? "";
      if (!cmd.includes("write") && !cmd.includes("edit")) return;
      const result = execSync("npm test");
      ctx.appendContext(`[auto-test]\n${result}`);
    });
  },
};
```

---

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

Node 有两个 kind：

| kind | 含义 |
|------|------|
| `"code"` | JS 函数。execute 内可以调 `ctx.runAgent()`，也可以不调。框架不区分 |
| `"graph"` | 引用另一个 Graph 作为子图，Runtime 自动委托子图执行 |

---

### code 节点：三种典型写法

**同一个 `kind: "code"` 节点，execute 函数体内自由组合代码和 agent**。

#### agent-only（只有 LLM 推理）

```typescript
execute: createAgentExecute({
  skill: "review-grade",
  prompt: (input) => `请批改：${input.data.question}`,
})
```

`createAgentExecute` 是语法糖——等价于 `execute = (_, input, ctx) => ctx.runAgent({ prompt, skill })`。**不是一种新的节点类型**。

> **注意**：agent 需要知道的信息必须在 `prompt` 中显式传入。框架不会自动 dump `input.data` 进上下文。如果你用 `createAgentExecute` 不带 `prompt`，agent 只能看到 CURRENT 段的 subGoal 和 skill 名。

#### code-only（只走代码，不调 LLM）

```typescript
execute: async (_instance, input, _ctx) => {
  fs.writeFileSync(input.data.path, JSON.stringify(input.data.payload));
  return { nodeId: "save", status: "ok", result: { saved: true } };
}
```

不需要 `callTool`，不需要 pi 的工具系统。`execute` 就是普通 async 函数，可以用任何 Node.js 或第三方库。

#### hybrid（代码 + agent 穿插）

```typescript
execute: async (instance, input, ctx) => {
  // 代码侧准备
  const fileContent = fs.readFileSync(input.data.filePath, "utf-8");
  const schema = await externalAPI.getValidationSchema();

  // agent 推理
  const result = await ctx.runAgent({
    prompt: `按以下 schema 校验数据：
${JSON.stringify(schema)}

数据：
${fileContent}`,
    skill: "review-grade",
  });

  // 代码侧善后
  if (result.status === "ok") {
    fs.writeFileSync(input.data.outputPath, JSON.stringify(result.result));
  }
  return result;
}
```

#### 完成度验证

验证函数可以声明在节点上（`validateCompletion`），也可以写在 `ctx.runAgent({ validateCompletion })` 里：

```typescript
execute: createAgentExecute({
  validateCompletion(result) {
    if (!result.score) return { isValid: false, reason: "缺少 score" };
    return { isValid: true };
  },
}),
```

验证不通过时，引擎自动注入重试消息让 LLM 继续工作。

### graph 节点（子图）

```typescript
const subNode: Node = {
  kind: "graph",
  id: "delegate",
  subGoal: "委托子图执行子任务",
  graph: mySubGraph,
};
```

子图采用隔离栈（新 AgentInstance，frames = []）。父图只看调用结果，不偷看子图内部历史。

---

## skill 集成

### 机制

`node.skill` 将对应的 SKILL.md 文件内容在节点进入时（哨兵之后）追加到消息流中。追加在哨兵之后，投影三段切分将其归入当前节点的 active 段；节点完成后该段随 ReAct 被帧摘要折叠，不泄漏到下一节点。

底层使用 `sendMessage({ display: false })`（不触发额外 LLM turn），遵守"追加不注入"原则。

### 位置约定

`skillBasePath/{skill名称}/SKILL.md`。默认 `skillBasePath` 为 `cwd/skills`，可通过 `createLoopGraphExtension(pi, { skillBasePath: "..." })` 配置。SDK 通过 `resources_discover` 事件将 `skillBasePath` 注册到 pi 的原生 skill 系统，pi 自动扫描 frontmatter 并在系统提示中以 XML 形式列出可用 skill。

### 多 skill 支持

**当前状态**：一个节点一次只能关联一个 skill（`node.skill?: string` 单值字段）。图级 `skills?: string[]` 数组未实现。

如果你需要在一个节点中使用多个 skill，有以下策略：

| 策略                             | 做法                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **拆到不同节点**           | 将不同 skill 的任务拆成多个串行/并行节点，各自的`node.skill` 指向不同的 skill                                                                                                             |
| **手动组合 prompt**        | 在`createAgentExecute({ prompt: input => ... })` 中自行读取并合并多个 skill 文件内容到 prompt 中                                                                                          |
| **纯代码绕过**             | `kind: "code"` 节点的 `execute` 是普通 async 函数，可以直接 import 和调用任何 domain 代码，不依赖 `node.skill` 机制                                                                   |
| **节点级 tools（最常用）** | 大多数场景下，你需要的不是多 skill，而是在当前节点附加一组专用工具。声明`tools: ["tool_a", "tool_b"]`，配合 `prompt` 字段告知 agent 如何协作即可。`tools` 和 `skill` 可以同时使用。 |

如果一条图中不同节点需要不同的 skill，这是完全支持的——每个节点声明各自的 `node.skill` 即可。

### 投影中的 skill 行

在 CURRENT 段中，`skill: {名称}` 行仅保留名称作为上下文提示。完整 skill 内容由主循环在进入节点时追加。projection 是纯函数，不接触 IO。

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
=== CURRENT ===   ← 当前节点信息（subGoal、工具、skill 名称）
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
  source:
    | { kind: "entry"; entryId: string }                // 来自入口
    | { kind: "edge"; edgeId: string; fromNodeId: string }; // 来自边
}
```

### 节点间传递

```
Edge.migrate 的 input 字段 → 下一节点的 NodeInput.data
```

`input` 只传递给直接后继节点。如果后续节点需要某些信息，必须在 `result` 中产出，经 `Edge.migrate` 折叠进帧。

### GraphInvocation 与命令入参

```typescript
interface GraphInvocation {
  name: string;                          // 命令名（/xxx）和工具名
  description: string;
  inputSchema: Record<string, unknown>;  // 工具入参 schema（agent tool-call 用）
  parseArgs?(args: string): Record<string, unknown>; // 命令调用：把裸文本解析为结构化入参
}
```

当用户输入 `/hello 世界` 时：

1. `GraphRegistry` 调用 `inv.parseArgs("世界")`，产出 `{ subject: "世界" }`
2. `params` 随 trigger 传入 `executeGraph`
3. `executeGraph` 以 `params` 构造 `background` → `Entry.guard(background)` → `Entry.mapInput(background)`

如果 `parseArgs` 未定义，命令 handler 默认传入 `{ args: rawString }`。

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
import { END, createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Entry, Graph, Node } from "pi-loop-graph-sdk";

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

// ── 入口：parseArgs 将 /r 数学 → { subject: "数学" }，直接作为 background ──

const entry: Entry = {
  id: "review_cmd",
  guard: (bg) => typeof bg.subject === "string" && bg.subject.length > 0,
  startNodeId: "select_target",
  mapInput: (bg) => ({ subject: bg.subject }),
};

// ── 图 ──

export const reviewGraph: Graph = {
  id: "quick_review",
  goal: "快速生成复习题目",
  invocation: {
    name: "r",
    description: "快速复习",
    inputSchema: { type: "object", properties: { subject: { type: "string" } } },
    // parseArgs 将 /r 数学 → { subject: "数学" }，直接作为 background
    parseArgs: (a) => ({ subject: a || "" }),
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

| 项                    | 当前策略                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callTool`          | 未实现。纯代码节点应直接调用业务库函数（Node.js API、第三方 SDK 等）；如果动作只能经 LLM tool-call 发生，就不能声称代码层强制执行该 tool。                              |
| `agent-choice` 路由 | 暂缓 / experimental。短期使用`priority-first`、`first-match` 或 `custom`。如需 LLM 选边，用 `custom` 自己实现（注册临时工具 → LLM 返回选择 → resume）。       |
| 多 skill              | 当前只有 node.skill?: string 单值字段，图级 skills?: string[] 未实现。多 skill 策略：拆到不同节点、手动组合prompt、纯代码绕过。参见 §skill 集成。                      |
| schema / 泛型类型     | `NodeCompletion.result`、`NodeInput.data`、`inputSchema` 当前保留 `Record<string, unknown>`；下一阶段补 schema helper 和泛型 API（`Node<TInput, TResult>`）。 |
| session 续跑          | 当前不持久化帧栈，图运行中断后需重新开始。                                                                                                                              |
