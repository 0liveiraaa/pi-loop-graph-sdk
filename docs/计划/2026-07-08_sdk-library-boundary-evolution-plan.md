# SDK Library Boundary Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前已能运行单 agent 图编排的 Loop Graph SDK 演进为可被其它 pi package 稳定导入、独立实例化、清晰区分 library/debug extension 的 SDK。

**Architecture:** 先把包边界和运行时工厂拆清楚：`"."` 只暴露 SDK library API，`"./extension"` 暴露可选 demo/debug pi extension。业务 extension 通过 `createLoopGraphExtension(pi)` 创建自己的 Loop Graph 运行时并注册业务图，不依赖 SDK 自带 extension 的加载顺序；测试图默认不注册，只在 debug/demo 模式下启用。

**Tech Stack:** TypeScript ESM, pi extension API (`@earendil-works/pi-coding-agent`), typebox, vitest, 当前 `GraphRuntime` / `PiNodeContext` / `registerGraph` 抽象。

---

## Context Summary

当前 SDK 已完成单 agent MVP：

- `Graph` / `Node` / `Edge` / `Router` 能表达单题 workflow。
- `ContextFrame[]` 帧栈和 projection 已验证。
- `Node.graph` 子图隔离栈已验证。
- `createAgentExecute` + `__graph_complete__` 完成度验证已验证。

本轮反馈暴露的核心问题不是图抽象，而是 SDK 分发和消费边界：

- 包被 pi 作为 extension 加载，不等于其它 pi package 能通过包名导入。
- `package.json` 没有 `main` / `exports`，README 的 `import ... from "pi-loop-graph-sdk"` 目前不可靠。
- `registerGraph` 依赖模块级 `_executeGraph`，必须先由 SDK 自带 extension `initRegistry(executeGraph)` 初始化。
- SDK 自带 extension 默认注册测试图，容易污染业务命令空间。
- `callTool`、多 skill、schema、`agent-choice` 是后续能力债，但不应阻塞 library 边界修复。

## File Structure

实施时建议按以下文件边界落地：

- Modify: `package.json`
  - 增加 library exports、extension 子路径、pi peer dependency 声明。
  - 保留 `pi.extensions` 指向 debug extension。
- Create: `src/adapter/loop-graph-extension.ts`
  - 新的可实例化运行时工厂，导出 `createLoopGraphExtension(pi, options?)`。
  - 持有 per-instance registry、active runtime/node context、context/tool/agent hooks。
- Modify: `src/adapter/extension.ts`
  - 变成可选 debug/demo extension 入口，只调用 `createLoopGraphExtension(pi, { demoGraphs: true })`。
- Modify: `src/registry.ts`
  - 从模块级单例改为实例级 registry class/factory。
  - 保留兼容导出时，应明确 deprecated 或只委托到默认实例。
- Modify: `src/index.ts`
  - 暴露 library API：类型、runtime、router、validation、`createAgentExecute`、`createLoopGraphExtension`。
  - 不导出 demo graphs 作为默认主路径能力。
- Create: `src/adapter/loop-graph-extension.test.ts`
  - 验证无全局初始化即可注册图。
  - 验证 demo graphs 默认不注册。
- Modify: `docs/设计/developer-guide.md`
  - 增加“作为业务 package 依赖使用”和“作为 debug extension 使用”的两种安装路径。
- Modify: `README.md`
  - 修正安装和 import 示例。
- Modify: `docs/形态/implementation-status.md`
  - 实施后更新当前状态和缺口。

## Milestones

### Milestone 1: Package Boundary First

目标：让 `import { ... } from "pi-loop-graph-sdk"` 成为稳定公开入口。

验收标准：

- `package.json` 包含 `main`、`exports["."]`、`exports["./extension"]`。
- 业务包文档明确：并列 `pi install` 只能加载 extension，不能让另一个 package 自动导入 SDK。
- `npm run typecheck` 通过。

### Milestone 2: Runtime Factory And Instance Registry

目标：业务 extension 不再依赖 SDK 自带 extension 初始化顺序。

验收标准：

- 业务侧可写：

```typescript
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { reviewSingleTurnGraph } from "./graphs/review-single-turn";

export default function reviewExtension(pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(reviewSingleTurnGraph);
}
```

- 不调用 SDK debug extension 时也不会出现 `loop-graph Registry 尚未初始化`。
- 多个业务 extension 创建各自 loop runtime 时，graph registry 不互相污染。

### Milestone 3: Debug Extension Is Explicit

目标：SDK 自带测试图继续可用，但默认语义清楚。

验收标准：

- `./extension` 是 demo/debug extension 入口。
- demo graph 注册由 `{ demoGraphs: true }` 控制。
- 默认 library 使用不会注册 `reviewGraph`、`probeGraph`、`chainGraph`、`subgraphGraph`、`validateGraph`。

### Milestone 4: Developer Experience Debt

目标：降低 Pi Review Agent 继续迁移 `/review-turn` 的接入摩擦。

验收标准：

- 文档给出两种安装方式：只作为 pi extension 使用、作为业务 extension dependency 使用。
- 文档明确 `callTool` 当前限制：纯代码节点应直接调用业务库函数；只能经 LLM 触发的 pi tool 不能被 SDK 宣称为代码强制执行。
- 文档将 `agent-choice` 标为 experimental/暂缓，推荐短期用 `priority-first` / `first-match` / `custom`。

## Task 1: Publishable Package Entry

**Files:**

- Modify: `package.json`
- Modify: `src/index.ts`
- Test: `npm run typecheck`

- [ ] **Step 1: Add package exports**

Update `package.json` to expose the library and optional extension:

```json
{
  "name": "pi-loop-graph-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./extension": "./src/adapter/extension.ts"
  },
  "pi": {
    "extensions": [
      "./src/adapter/extension.ts"
    ]
  }
}
```

Keep existing `scripts`, `dependencies`, and `devDependencies`. Move `@earendil-works/pi-coding-agent` and `typebox` to `peerDependencies` only if runtime package testing confirms pi supplies them for git packages; otherwise keep current dependency layout and document the choice.

- [ ] **Step 2: Export the future runtime factory from the public API**

After Task 2 creates `src/adapter/loop-graph-extension.ts`, update `src/index.ts`:

```typescript
export { createLoopGraphExtension } from "./adapter/loop-graph-extension.js";
export type { LoopGraphExtension, LoopGraphExtensionOptions } from "./adapter/loop-graph-extension.js";
```

- [ ] **Step 3: Verify package typing**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits successfully with no new errors.

## Task 2: Instance-Scoped Loop Graph Extension

**Files:**

- Create: `src/adapter/loop-graph-extension.ts`
- Modify: `src/adapter/extension.ts`
- Modify: `src/registry.ts`
- Test: `src/adapter/loop-graph-extension.test.ts`

- [ ] **Step 1: Define the runtime factory API**

Create `src/adapter/loop-graph-extension.ts` with an exported API shape:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Graph } from "../type.js";

export interface LoopGraphExtensionOptions {
  demoGraphs?: boolean;
  defaultTools?: string[];
}

export interface LoopGraphExtension {
  registerGraph(graph: Graph): void;
  executeGraph(
    graph: Graph,
    trigger: { source: "command"; args?: string } | { source: "tool"; params?: Record<string, unknown> },
  ): Promise<void>;
}

export function createLoopGraphExtension(
  pi: ExtensionAPI,
  options: LoopGraphExtensionOptions = {},
): LoopGraphExtension {
  // Move the current extension.ts runtime wiring here.
}
```

The implementation should move the current `executeGraph`, `execNode`, `runSubgraph`, active runtime/node context, projection hook, `__graph_complete__` hook, and tool management into this factory closure so each created Loop Graph extension has isolated state.

- [ ] **Step 2: Replace global registry dependency**

Refactor `src/registry.ts` into an instance-friendly helper:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Graph } from "./type.js";

export type ExecuteGraph = (
  graph: Graph,
  trigger: { source: "command"; args?: string } | { source: "tool"; params?: Record<string, unknown> },
) => Promise<void>;

export class GraphRegistry {
  private readonly graphs = new Map<string, Graph>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly executeGraph: ExecuteGraph,
  ) {}

  registerGraph(graph: Graph): void {
    if (this.graphs.has(graph.id)) throw new Error(`图 "${graph.id}" 已注册`);
    this.graphs.set(graph.id, graph);
    // Register invocation command/tool here using this.executeGraph.
  }
}
```

The command handler must parse args using `graph.invocation?.parseArgs` before invoking the graph, because `GraphInvocation.parseArgs` already exists in `type.ts`.

- [ ] **Step 3: Keep public usage simple**

`createLoopGraphExtension(pi)` should internally construct `new GraphRegistry(pi, executeGraph)` and return:

```typescript
return {
  registerGraph: (graph) => registry.registerGraph(graph),
  executeGraph,
};
```

- [ ] **Step 4: Update debug extension entry**

Change `src/adapter/extension.ts` to become thin:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopGraphExtension } from "./loop-graph-extension.js";

export default function loopGraphDebugExtension(pi: ExtensionAPI) {
  createLoopGraphExtension(pi, { demoGraphs: true });
}
```

- [ ] **Step 5: Verify no initialization-order dependency remains**

Add a vitest test with a minimal fake `pi` object:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createLoopGraphExtension } from "./loop-graph-extension.js";

it("registers a graph without SDK debug extension initialization", () => {
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
  } as any;

  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(minimalGraph);

  expect(pi.registerCommand).toHaveBeenCalledWith("minimal", expect.any(Object));
  expect(pi.registerTool).toHaveBeenCalled();
});
```

Run:

```bash
npm run test -- src/adapter/loop-graph-extension.test.ts
```

Expected: PASS.

## Task 3: Demo Graph Registration Gate

**Files:**

- Modify: `src/adapter/loop-graph-extension.ts`
- Modify: `src/adapter/extension.ts`
- Test: `src/adapter/loop-graph-extension.test.ts`

- [ ] **Step 1: Move demo imports behind the demo option**

Inside `createLoopGraphExtension`, register built-in graphs only when `options.demoGraphs === true`:

```typescript
if (options.demoGraphs) {
  registry.registerGraph(reviewGraph);
  registry.registerGraph(probeGraph);
  registry.registerGraph(chainGraph);
  registry.registerGraph(subgraphGraph);
  registry.registerGraph(validateTestGraph);
}
```

If static imports create unwanted library-side coupling, use dynamic imports inside this branch in a later cleanup task. The first implementation can keep static imports to minimize churn.

- [ ] **Step 2: Add tests for default behavior**

Test:

```typescript
const loop = createLoopGraphExtension(pi);
expect(pi.registerCommand).not.toHaveBeenCalledWith("probe", expect.any(Object));
expect(pi.registerCommand).not.toHaveBeenCalledWith("chain", expect.any(Object));
```

Test debug behavior:

```typescript
createLoopGraphExtension(pi, { demoGraphs: true });
expect(pi.registerCommand).toHaveBeenCalled();
```

- [ ] **Step 3: Verify**

Run:

```bash
npm run test -- src/adapter/loop-graph-extension.test.ts
npm run typecheck
```

Expected: both pass.

## Task 4: Documentation For Two Consumption Modes

**Files:**

- Modify: `README.md`
- Modify: `docs/设计/developer-guide.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Document mode A, debug/demo extension**

Add a section:

````markdown
### 作为 debug/demo pi extension 使用

```bash
pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
```

这种方式会加载 SDK 自带 extension，用于运行 SDK demo/test graphs。它不等于其它 pi package 可以直接从自己的代码中导入 SDK。
````

- [ ] **Step 2: Document mode B, business package dependency**

Add a section:

````markdown
### 作为业务 extension 的 library 依赖使用

业务 package 必须在自己的 `package.json` 中声明依赖：

```json
{
  "dependencies": {
    "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1"
  }
}
```

然后在业务 extension 中创建独立运行时：

```typescript
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { reviewSingleTurnGraph } from "./graphs/review-single-turn";

export default function reviewExtension(pi) {
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(reviewSingleTurnGraph);
}
```
````

- [ ] **Step 3: Document known limitations honestly**

Update limitations:

```markdown
| 项 | 当前策略 |
| --- | --- |
| `callTool` | 未实现。纯代码节点应直接调用业务库函数；如果动作只能经 LLM tool-call 发生，就不能声称代码层强制执行该 tool。 |
| `agent-choice` | 暂缓/experimental。短期使用 `priority-first`、`first-match` 或 `custom`。 |
| 多 skill | 当前单 `skill?: string`；下一阶段引入 `graph.skills + node.skills`。 |
| schema/泛型 | 当前保留 `Record<string, unknown>`；下一阶段补 schema helper 和泛型 API。 |
```

- [ ] **Step 4: Verify docs examples align with package name**

Search:

```bash
rg "pi-loop-graph-extension|pi-loop-graph-sdk/src|initRegistry|Registry 尚未初始化" README.md docs src
```

Expected:

- Public docs use `pi-loop-graph-sdk`.
- No user-facing example imports `pi-loop-graph-sdk/src/index.ts`.
- `initRegistry` only appears in migration notes or removed code.

## Task 5: Short-Term Review Agent Migration Gate

**Files:**

- Create: `docs/计划/2026-07-08_review-agent-single-turn-validation.md`
- Modify: `docs/loop-graph-sdk-usage-feedback.md`

- [ ] **Step 1: Record SDK-side acceptance checklist**

Create a small follow-up plan for Pi Review Agent validation after Tasks 1-4:

```markdown
# Review Agent Single Turn Validation Plan

**Prerequisites:**
- SDK package exports are available.
- Business package declares `pi-loop-graph-sdk` in dependencies.
- Business extension uses `createLoopGraphExtension(pi)`.

**Validation Flow:**
- Register `/review-turn` only.
- Keep existing `/review` unchanged.
- Run one single-turn graph:
  `prepare_review_turn -> show_material -> generate_question -> answer_question -> grade_answer -> archive_turn -> choose_turn_action -> END`.

**Pass Criteria:**
- `/review-turn` starts without module resolution warning.
- Graph reaches `archive_turn`.
- If archive is agent-tool-driven, docs state that archival is agent-enforced, not code-enforced.
- Existing `/review` behavior remains unchanged.
```

- [ ] **Step 2: Update usage feedback status**

Append a short “SDK response plan” section to `docs/loop-graph-sdk-usage-feedback.md` linking to this plan and marking P0/P1 items as planned.

## Task 6: Capability Roadmap After Library Boundary

**Files:**

- Modify: `docs/设计/loop-graph-sdk-design.md`
- Modify: `docs/形态/implementation-status.md`
- Future implementation files after boundary tasks are complete.

- [ ] **Step 1: Plan multi-skill support**

Design target:

```typescript
interface Graph {
  skills?: string[];
}

type CodeNode = {
  skills?: string[];
  skill?: string; // deprecated compatibility alias
};
```

Runtime should merge:

```text
graph.skills + node.skills + node.skill
```

Do this after package/runtime factory work so API compatibility can be tested against real business imports.

- [ ] **Step 2: Plan schema helpers before deep generics**

Short-term target:

```typescript
node.inputSchema
node.outputSchema
edge.inputSchema
createRequireFieldsValidator(["question", "answer"])
```

Long-term target:

```typescript
Node<TInput, TResult>
Edge<TFromResult, TToInput>
```

Keep schema helper first because it directly improves `createAgentExecute` validation without forcing a large type-system rewrite.

- [ ] **Step 3: Mark agent-choice as experimental**

Until a concrete implementation is chosen, change user-facing docs to say:

```markdown
`agent-choice` is declared for future compatibility and currently experimental. Use `custom` if a graph needs model-assisted route selection.
```

Do not expose it as stable until the SDK defines one of:

- `completion.result.next_edge_id`
- `__graph_choose_edge__`
- router prompt over candidate edges

- [ ] **Step 4: Revisit callTool only after pi API confirmation**

Before implementing `PiNodeContext.callTool`, confirm whether pi exposes a stable extension-side tool invocation API. If it does not, keep the current explicit error and strengthen docs around pure code nodes calling domain services directly.

## Self-Review Checklist

- Spec coverage: P0 package entry and dependency visibility are covered by Tasks 1 and 4.
- Spec coverage: P1 library/debug separation and registry initialization are covered by Tasks 2 and 3.
- Spec coverage: P1 `callTool`, multi-skill, schema debt and P2 `agent-choice` are sequenced in Task 6.
- Placeholder scan: no task uses TBD/TODO/implement later wording.
- Type consistency: public factory name is consistently `createLoopGraphExtension`; registry type is `GraphRegistry`; current `registerGraph(pi, graph)` is intentionally replaced by `loop.registerGraph(graph)` for new usage.
