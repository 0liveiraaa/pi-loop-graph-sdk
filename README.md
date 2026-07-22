# Loop Graph SDK

把一次复杂的 Agent 任务，变成一张看得见、走得通、查得清的工作图。

Loop Graph SDK 面向需要长期运行、多阶段推进和可复核结果的 Pi 应用。它让你用一张图表达“先做什么、检查什么、失败后回到哪里、最后交付什么”，同时保留 Agent 适合探索和推理的自由度。

它特别适合：

- 资料整理、生成、审查、修改、再次审查这样的多阶段工作；
- 代码处理和 Agent 推理交替进行的流程；
- 需要工具白名单、自动验收和失败边界的 Agent 应用；
- 需要复用子流程，又不能让上下文和状态互相污染的任务；
- 需要在运行后回答“模型看到了什么、走了哪一步、为什么接受或拒绝”的系统。

## 如何使用

### 1. 安装为项目依赖

Loop Graph SDK 首先是一个可被其他项目导入的 library。业务项目通常只需要安装包，然后从根入口创建自己的图和 Extension；SDK 自带的 `/extension` 入口只用于调试和演示，不是业务项目必须安装的运行方式。

当前仓库支持以下依赖方式：

```bash
# 本地开发：从相邻工作区安装
npm install ../pi-loop-graph-extension-public

# 发布前验证：先生成 tarball，再在业务项目安装
npm pack
npm install ./pi-loop-graph-sdk-0.1.1.tgz

# Git 依赖：使用实际仓库地址和固定 tag/commit
npm install git+https://github.com/<owner>/<repo>.git#<tag-or-commit>
```

安装后，业务项目可以使用稳定根入口：

```ts
import {
  agentNode,
  codeNode,
  createGraphHost,
  createLoopGraphExtension,
  defineGraph,
  graphNode,
} from "pi-loop-graph-sdk";
```

回放和高级能力使用独立入口：

```ts
import { parseReplay, exportReplayHtml } from "pi-loop-graph-sdk/replay";
import { GraphRuntime, validateGraph } from "pi-loop-graph-sdk/advanced";
```

当前 `package.json` 保留了 `private: true`，因此暂时不能直接从 npm registry 安装；本地目录、tarball 和 Git 依赖均可使用。将来发布到 npm 时，只需要在不改变这些 package subpath 的前提下移除该限制并发布正式版本。

### 2. 运行最小示例

下面是一张只有一个代码阶段的图。它不需要模型认证，适合先确认图、阶段、路线和结果处理方式。

```ts
import {
  Type,
  codeNode,
  createGraphHost,
  defineGraph,
  entry,
  finish,
  firstMatch,
} from "pi-loop-graph-sdk";

const Input = Type.Object({ name: Type.String() });
const Output = Type.Object({ message: Type.String() });

const helloGraph = defineGraph({
  id: "hello",
  version: "1",
  goal: "生成问候语",
  input: Input,
  output: Output,
  context: {
    background: { select: "all" },
  },
  entries: [entry("main", { to: "greet" })],
  stages: {
    greet: {
      node: codeNode({
        subGoal: "生成问候语",
        input: Input,
        output: Output,
        execute: ({ input, complete }) =>
          complete({ message: `Hello, ${input.name}` }),
      }),
      route: firstMatch({
        done: finish({
          output: ({ completion }) => completion.result,
        }),
      }),
    },
  },
});

const host = createGraphHost({ recording: "off" });

try {
  const result = await host.execute(helloGraph, { name: "World" });

  if (result.status === "completed") {
    console.log(result.output.message);
  } else {
    console.error(result.failure.code, result.failure.message);
  }
} finally {
  await host.dispose();
}
```

这里的对应关系是：

- `defineGraph` 描述整张任务图；
- `entry` 描述从哪里开始；
- `codeNode` 描述一个代码阶段；
- `firstMatch` 和 `finish` 描述路线和结束；
- `createGraphHost` 提供一次可管理生命周期的执行通道。

### 3. 从代码阶段换成 Agent 阶段

当阶段需要模型推理时，把 `codeNode` 换成 `agentNode`。输入、输出、工具和 Skill 仍然是图定义的一部分：

```ts
import {
  Type,
  agentNode,
  skillRef,
  toolSet,
} from "pi-loop-graph-sdk";

const DraftInput = Type.Object({ topic: Type.String() });
const DraftOutput = Type.Object({ answer: Type.String() });

const writeDraft = agentNode({
  subGoal: "根据主题撰写简洁答案",
  input: DraftInput,
  output: DraftOutput,
  prompt: "完成当前阶段，并提交符合输出契约的结构化结果。",
  tools: toolSet("read"),
  skills: [skillRef("answer-writing", "1")],
  context: {
    focus: { select: "all" },
  },
});
```

Agent 完成当前阶段时，必须通过受保护的完成工具提交：

```text
__graph_complete__({ result })
```

提交对象只允许 `{ result }`。`status`、`reportedStatus` 和其他额外字段不属于模型协议，会被拒绝。接受、拒绝和失败由 SDK 根据输出契约、验证器、Mechanism 和路线规则决定，而不是由模型自报状态决定。

### 4. 作为 Pi Extension 使用

业务 Extension 负责创建自己的实例、注册图，再决定怎样对外暴露：

```ts
import {
  createLoopGraphExtension,
  graphRef,
} from "pi-loop-graph-sdk";
import { helloGraph } from "./hello-graph.js";

export default function setup(pi) {
  const loop = createLoopGraphExtension(pi);

  loop.registerGraph(helloGraph);
  loop.exposeGraph(graphRef("hello", "1"), {
    kind: "command",
    name: "hello",
    description: "生成问候语",
    parseInput: (args) => ({ name: args.trim() || "World" }),
  });
}
```

注册和暴露是两个动作：同一张图可以注册一次，再按需要暴露成命令或工具。SDK 自带的 `/extension` 入口只用于调试和演示；业务代码应创建自己的 Extension 实例。

### 5. 处理结果、取消与生命周期

每次执行都会得到一个 `GraphRunResult`：

- `completed`：提供经过输出 schema 检查的 `output`；
- `failed`：提供结构化 `failure`，包括错误代码、阶段、消息和是否可重试；
- `cancelled`：提供取消原因。

同一个 Host 只允许一个 Root Run。并发 Root Run 应创建独立 Host。外部 `AbortSignal` 会传播到活动执行；`dispose()` 会等待活动运行清理完成后再释放资源。

### 6. 使用 Recording、Replay 与 Resume

Host 默认使用 `replay` 记录，并将运行数据写入 `.loop-graph/runs/{rootRunId}`。也可以按运行选择 `off`、`events`、`replay` 或 `forensic`：

```ts
const result = await host.execute(graph, input, {
  recording: "replay",
  recordingRequired: true,
});

console.log(result.replay.status, result.replay.location);
```

Replay 的离线读取和 HTML 导出来自独立入口：

```ts
import {
  exportReplayHtml,
  parseReplay,
} from "pi-loop-graph-sdk/replay";

const model = parseReplay(replayJsonText);
const html = exportReplayHtml(model);
```

当前 checkpoint/resume 支持单层 Root 在阶段边界可靠恢复。嵌套 `call`、`compose`、`delegate` 的 continuation 恢复尚未完成；遇到这类 checkpoint 时会返回 `resume-incompatible`，不会把子图状态错误套用到父图。

### 7. 选择公开入口

日常业务代码优先使用根入口：

```ts
import {
  agentNode,
  codeNode,
  createGraphHost,
  createLoopGraphExtension,
  defineGraph,
  graphNode,
} from "pi-loop-graph-sdk";
```

需要底层图运行时、验证器、路由器或高级隔离 Host 时，再使用：

```ts
import {
  GraphRuntime,
  selectEdge,
  validateGraph,
} from "pi-loop-graph-sdk/advanced";
```

需要记录、回放和 checkpoint 类型时使用：

```ts
import {
  FileRunStore,
  decodeCheckpoint,
  parseReplay,
} from "pi-loop-graph-sdk/replay";
```

旧的全局 `registerGraph`、`initRegistry`、`findEntry` 和 `createAgentExecute` 不属于 0.2 公共 API。

## 四个核心概念

完成第一次运行后，可以用四个概念理解 SDK 解决了什么问题。把它想成“带有函数调用边界和完整工作记录的 Agent 工作流引擎”即可，不需要理解内部运行代码。

### 1. 回路图：把任务过程画出来

一张图由入口、阶段和路线组成。每个阶段完成后，路线决定下一步去哪里：继续、回到之前的阶段，或者结束并交付结果。

模型在一个阶段内部可以进行多轮思考和工具调用；这些细节属于阶段内部的工作过程。图只表达跨阶段的业务流程，因此读图时可以直接看到任务如何推进，而不会被一长串对话淹没。

### 2. 上下文帧栈：像函数调用栈一样记住工作

跨阶段的信息不是散落在全局变量里，而是进入一个有顺序的上下文帧栈：

```text
任务背景
  └─ 阶段 A 完成后留下的工作记忆
      └─ 阶段 B 完成后留下的工作记忆
          └─ 当前阶段的工作区
```

阶段结束时，流程只把后续真正需要的内容折叠成一帧：

- 后续 Agent 看到有用的工作记忆，而不是前面所有原始对话；
- 每条路线决定“这次完成应该留下什么”，状态迁移不会藏在节点副作用里；
- 子流程返回时可以收拢临时记忆，不把内部过程泄露给调用方。

帧栈和完整日志是两件事：帧栈服务于下一步工作，日志服务于之后审计和复盘。

### 3. 三种调用边界：像三种函数调用方式

子图可以像函数一样被另一个阶段调用，但你可以明确选择它与调用方共享多少工作上下文：

| 边界 | 可以把它理解成 | 适合场景 |
| --- | --- | --- |
| `call` | 调用一个有独立工作区的函数，完成后返回结果 | 复用审查、提取、分类等完整子流程 |
| `compose` | 把复杂函数展开成当前函数内部的一段临时步骤 | 子流程需要读取父流程工作记忆，返回时再折叠回去 |
| `delegate` | 交给一个独立 worker，会话和资源都隔离 | 长任务、风险任务或需要独立生命周期的工作 |

三种边界都表达顺序调用，不代表自动并行。

### 4. 完整日志系统：运行之后仍然能还原过程

SDK 的记录不是简单的一行“成功/失败”日志。它可以记录：

- 图、阶段、调用边界和节点进入/退出；
- Agent 执行、模型回合、工具调用和工具结果；
- 完成结果的提交、验证、接受或拒绝；
- 上下文快照、压缩、扩展机制和恢复点；
- 大结果的独立文件引用以及脱敏后的安全摘要。

记录可以选择关闭、事件记录、Replay 或 forensic 模式。Replay 可以解析成结构化模型，也可以导出 HTML 报告，用来回答“模型看到了什么”和“系统为什么做出这个决定”。完整审计不会挤占下一阶段的工作上下文。

## 当前边界

- 一次图运行沿一条明确路径推进，不提供自动 fork/join 并行调度；
- 多 Agent 通讯是独立研究方向，不是当前公共能力；
- `delegate` 是隔离执行边界，不等于并行；
- 真实 LLM 测试需要可用认证、网络和模型响应；默认测试会跳过这类测试；
- Study Helper 六张图是业务回归，不属于 SDK 默认测试门禁。

默认不会写调试日志文件。`debug: true` 只属于旧兼容/characterization 路径，不是当前 0.2 根入口的公共配置；正式审计应使用 recording/replay。

## 验证项目

在仓库中运行：

```powershell
npm run typecheck
npm test
npm run test:package-consumer
npm pack --dry-run --json
git diff --check
```

## 文档索引

### 第一次使用

- [十分钟快速开始](docs/getting-started.md)
- [0.1 → 0.2 迁移指南](docs/migration-0.1-to-0.2.md)

### 理解系统

- [核心概念索引](docs/concepts/README.md)
- [图模型](docs/concepts/graph-model.md)
- [上下文与状态](docs/concepts/context-and-state.md)
- [子图调用边界](docs/concepts/subgraph-boundaries.md)
- [Mechanism](docs/concepts/mechanisms.md)

### 完成具体任务

- [任务指南索引](docs/guides/README.md)
- [构建循环和条件路由](docs/guides/build-a-loop.md)
- [混合代码与 Agent](docs/guides/mix-code-and-agent.md)
- [调用子图](docs/guides/call-subgraphs.md)
- [控制工具](docs/guides/control-tools.md)
- [上下文定制](docs/guides/customize-context.md)
- [可观测性](docs/guides/observability.md)

### 查询精确行为

- [API 参考索引](docs/reference/README.md)
- [配置项](docs/reference/configuration.md)
- [生命周期](docs/reference/lifecycle.md)
- [错误与运行限制](docs/reference/errors-and-limits.md)

### 维护 SDK

- [核心设计](docs/design/core-design.md)
- [内部实现索引](docs/internals/README.md)
- [ADR](docs/adr/)

### 研究

- [研究文档](docs/research/README.md)

英文说明见 [README-EN.md](README-EN.md)。
