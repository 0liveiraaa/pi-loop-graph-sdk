# Loop Graph SDK 使用反馈

> 日期：2026-07-08
> 来源：Pi Review Agent 尝试接入 `pi-loop-graph-sdk`

## 背景

Pi Review Agent 已尝试把 `/review` 的单题流程迁移为一张回路图：

```text
prepare_review_turn
  -> show_material
  -> generate_question
  -> answer_question
  -> grade_answer
  -> archive_turn
  -> choose_turn_action
  -> END
```

目标不是立刻替换现有 `/review`，而是先并行注册 `/review-turn`，验证 SDK 能否表达“关键动作必须发生”的单 agent ReAct + workflow 编排。

## 当前接入结论

SDK 的核心抽象方向是可用的：

- `Graph` 能表达单题流程结构。
- `Node` 能承载阶段工作和 ReAct。
- `Edge` 能承载状态迁移和上下文折叠。
- `Router` 能决定单一后继边。
- `ContextFrame[]` 的有序帧栈适合记录节点历史。
- `Node.graph` 的隔离子图设计适合后续把 `/review-init`、`/review-fix` 拆成可复用图。

但作为“可被其他 pi package 使用的 SDK”，目前暴露出几个会阻碍真实接入的问题。

## P0：包入口不可用

### 现象

Pi 启动时出现：

```text
Warning: Loop Graph SDK not available; /review-turn disabled:
Cannot find module 'pi-loop-graph-sdk/src/index.ts'
Require stack:
- ...\pi-review-agent\workspace\extensions\review\index.ts

Loop Graph Extension 已加载
```

### 根因

`pi-loop-graph-sdk` 作为 pi package 已经被 pi 加载，所以能看到 “Loop Graph Extension 已加载”。

但这不代表另一个 package 可以直接通过包名导入它。`pi-review-agent` 从自己的 package 目录解析依赖，而它的依赖里没有 `pi-loop-graph-sdk`。

另一个问题是 SDK 当前 `package.json` 没有公开库入口。README 示例写的是：

```ts
import { registerGraph, createAgentExecute, END } from "pi-loop-graph-sdk";
```

但实际只能尝试深路径：

```ts
import("pi-loop-graph-sdk/src/index.ts")
```

这不适合作为稳定 SDK API。

### 建议

SDK 的 `package.json` 增加库入口：

```json
{
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

如果希望同时暴露 extension 入口，可以明确分开：

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./extension": "./src/adapter/extension.ts"
  },
  "pi": {
    "extensions": ["./src/adapter/extension.ts"]
  }
}
```

这样消费方才能写：

```ts
import { registerGraph, createAgentExecute, END } from "pi-loop-graph-sdk";
```

## P0：SDK 作为库使用时缺少依赖安装说明

### 现象

Pi 的 `settings.json` 同时安装了：

```json
{
  "packages": [
    "git:git@github.com:0liveiraaa/pi-review-agent",
    "git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1"
  ]
}
```

但 `pi-review-agent` 仍然不能导入 `pi-loop-graph-sdk`。

### 根因

这两个 package 是并列安装，不是依赖关系。一个 package 被 pi 加载为 extension，不等于它进入另一个 package 的 `node_modules`。

### 建议

SDK 文档需要明确两种安装方式：

#### 只作为 pi extension 使用

```bash
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
```

适用于运行 SDK 自带测试图、调试图。

#### 作为业务 extension 的依赖使用

业务包需要在自己的 `dependencies` 中声明：

```json
{
  "dependencies": {
    "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1"
  }
}
```

然后业务代码再导入：

```ts
import { registerGraph } from "pi-loop-graph-sdk";
```

## P1：库入口和调试 extension 入口需要分离

### 现象

SDK 目前既是库，又自带 pi extension，并且 extension 会自动注册测试图：

- `reviewGraph`
- `probeGraph`
- `chainGraph`
- `subgraphGraph`
- `validateGraph`

这对 SDK 自测很方便，但业务接入时容易混淆：

- 我是要使用 SDK 库？
- 还是要加载 SDK 自带 extension？
- 业务图应该注册到哪个运行时？
- 自带测试图是否会污染用户命令空间？

### 建议

把“库模式”和“调试 extension 模式”写清楚。

建议结构：

```text
pi-loop-graph-sdk
  "."            -> SDK library API
  "./extension"  -> optional debug/demo pi extension
```

SDK 自带 extension 可以继续用于演示和调试，但业务包依赖 SDK 时，不应自动注册测试图。

## P1：`registerGraph` 依赖全局 Registry 初始化

### 现象

`registerGraph()` 依赖 `initRegistry(executeGraph)` 先被 SDK extension 调用。

如果业务 extension 只导入 SDK library，但没有加载 SDK 自带 extension，就可能出现：

```text
loop-graph Registry 尚未初始化
```

### 问题

这会让 SDK 的库用法和 extension 用法绑得太紧。

业务包想做的是：

```ts
registerGraph(pi, graph)
```

但它还需要知道 SDK extension 是否已经初始化了运行时。

### 建议

提供一个无全局依赖的注册入口，例如：

```ts
createLoopGraphRuntime().registerGraph(pi, graph)
```

或：

```ts
registerGraph(pi, graph, { runtime: createDefaultRuntime() })
```

更理想的开发者体验：

```ts
import { createLoopGraphExtension } from "pi-loop-graph-sdk";

export default function (pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(reviewSingleTurnGraph);
}
```

这样业务 extension 不需要依赖 SDK 自带测试 extension 的加载顺序。

## P1：`NodeContext.callTool` 未实现

### 现象

Pi Review Agent 的关键动作包括：

- `review_answer`
- `review_archive`
- `review_turn_action`

在理想回路中，某些动作应该由代码强制发生。例如判题后必须归档。

但当前 `PiNodeContext.callTool()` 还未实现，代码节点无法直接调用 pi tool，只能让 agent 在节点内调用工具。

### 影响

图结构可以保证进入 `archive_turn` 节点，但不能保证工具调用由代码直接完成。

也就是说，目前仍然是：

```text
图保证进入归档节点
agent 在归档节点内调用 review_archive
```

还不是：

```text
图进入归档节点
代码直接调用 review_archive
```

### 建议

优先补 `callTool()` 或提供等价能力，让代码节点可以调用已注册工具。

如果 pi-agent 当前没有公开“从 extension 内部调用 tool”的 API，可以在 SDK 文档中明确：

- 哪类节点适合 agent 主导；
- 哪类节点适合纯代码实现；
- 纯代码节点应该直接调用业务库函数，而不是调用 pi tool；
- 如果业务 tool 只能通过 LLM 调用，就不能声称代码层已经强制执行该 tool。

## P1：节点 skill 只能声明一个

### 现象

Pi Review Agent 的节点通常需要两类规则：

- 全局规则：`review-core`
- 阶段规则：`review-question`、`review-grade`、`review-summary`

当前 Node 只有：

```ts
skill?: string
```

### 建议

支持：

```ts
skills?: string[]
```

或图级默认 skill：

```ts
graph.skills = ["review-core"]
node.skills = ["review-question"]
```

运行时进入节点时合并：

```text
graph.skills + node.skills
```

## P1：`createAgentExecute` 的结果验证有用，但类型口袋太宽

### 现象

`NodeCompletion.result`、`NodeInput.data`、`GraphInvocation.inputSchema` 都是 `Record<string, unknown>`。

这让早期开发很快，但业务图变复杂后，错误会推迟到运行时。

### 建议

短期保留当前灵活性，但增加可选 schema：

```ts
node.inputSchema
node.outputSchema
edge.inputSchema
```

或提供泛型版本：

```ts
Node<TInput, TResult>
Edge<TFromResult, TToInput>
```

长期建议至少让 `validateCompletion` 有统一工具函数，不要每个业务节点手写检查。

## P2：`agent-choice` 已声明但未实现

### 现象

`RouterStrategy` 支持：

```ts
{ kind: "agent-choice" }
```

但当前实现会抛错：

```text
agent-choice 未实现
```

### 建议

如果短期不做，文档和类型里标记为 experimental 或暂缓。

如果要做，建议定义清楚 agent 如何选择边：

- 通过 `__graph_complete__.result.next_edge_id`
- 通过单独的 `__graph_choose_edge__` 工具
- 通过 router prompt 让 agent 在候选边中选择

对 Pi Review Agent 来说，题后动作适合 agent 或用户选择型边，但归档链路不适合。

## P2：运行时注册测试图可能影响业务使用

### 现象

SDK extension 加载时自动注册多个测试图。

### 建议

测试图只在显式 debug 模式注册，例如：

```ts
createLoopGraphExtension(pi, { demoGraphs: true })
```

默认只注册基础运行时和内部工具，不注册示例命令。

## P2：错误提示可以更面向业务开发者

### 现象

业务侧导入失败后，只能看到模块找不到。

### 建议

SDK 可以提供一段“常见接入错误”文档，尤其说明：

- pi package 并列安装不等于依赖可见；
- 业务包需要把 SDK 放进自己的 `dependencies`；
- SDK 库入口应从 `pi-loop-graph-sdk` 导入；
- SDK 自带 extension 只是演示和运行时注册方式之一。

## 对 Pi Review Agent 的短期建议

在 SDK 修复包入口和依赖说明前，Pi Review Agent 侧不要继续扩大迁移范围。

建议等待 SDK 完成：

1. `exports` / `main` 可用。
2. 业务包能通过 `dependencies` 稳定导入 SDK。
3. `registerGraph` 不依赖另一个 extension 的初始化顺序，或文档明确加载要求。

然后再继续迁移：

1. `/review-turn` 单题回路跑通。
2. `/review` 选择阶段仍用现有 TUI，选择完成后进入图。
3. `/review-init` 和 `/review-fix` 分别拆成资料构建图和资料修订图。

## 本次接入暴露的核心问题

SDK 作为"图语言运行时"的抽象已经能表达业务流程。

当前最大问题不是图抽象，而是包使用边界：

```text
它已经能作为一个 pi extension 被加载；
但还没有成为一个容易被其他 pi extension 稳定导入的 SDK library。
```

先解决这个问题，再继续推进 Pi Review Agent 迁移会更稳。

---

## SDK 响应计划（2026-07-08 更新）

> 详见：`docs/计划/2026-07-08_sdk-library-boundary-evolution-plan.md`

### 已修复（2026-07-08）

| 项目 | 优先级 | 状态 | 修复方式 |
| --- | --- | --- | --- |
| 包入口不可用 | P0 | ✅ 已修复 | `package.json` 增加 `main` + `exports["."]` + `exports["./extension"]` |
| 缺少依赖安装说明 | P0 | ✅ 已修复 | README / developer-guide 新增两种安装方式 |
| 库入口和 debug extension 分离 | P1 | ✅ 已修复 | `"."` 暴露 library API；`"./extension"` 为可选 debug entry |
| registerGraph 依赖全局初始化 | P1 | ✅ 已修复 | `createLoopGraphExtension(pi)` 工厂 + 实例级 `GraphRegistry` |
| 测试图污染命令空间 | P2 | ✅ 已修复 | `{ demoGraphs: true }` 门控；默认不注册 demo graphs |
| parseArgs 命令入口 | - | ✅ 已修复 | 命令 handler 先调 `parseArgs(args)` 再执行图 |
| tool execute 闭包绑定 | - | ✅ 已修复 | 工具注册用局部常量而非 `this` |
| 子图 agent 节点挂起 | - | ✅ 已修复 | `runSubgraphInExtension` 收回工厂闭包，恢复 push/pop |
| 多实例重复注册完成工具 | - | ✅ 已修复 | `WeakSet` per-pi 幂等 |

### 延后处理

| 项目 | 优先级 | 计划 |
| --- | --- | --- |
| `callTool` | P1 | 等 pi 公开稳定 extension-side tool 调用 API；当前代码节点可直接 import 业务库 |
| 多 skill | P1 | 下一阶段引入 `graph.skills + node.skills` |
| schema / 泛型 | P1 | 先补 schema helper（`createRequireFieldsValidator`），再泛型化 |
| `agent-choice` | P2 | 标记为 experimental；短期用 `custom` 替代 |

### Pi Review Agent 下一步

等待 Tasks 1-4 完成后（已完成），启动单题回路验证：
- `/review-turn` 并行运行，不替换 `/review`
- 验收标准见 `docs/计划/2026-07-08_review-agent-single-turn-validation.md`
