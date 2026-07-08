# Single Agent Runtime MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑通单 agent、单活动位置的 Loop Graph 主循环，让 `Graph.entries -> Node.execute -> Edge.migrate -> Router -> END` 成为可测试的最小闭环。

**Architecture:** MVP 只实现栈式单后继 runtime，不实现 fork/join、多 agent 通讯、声明式 JSON 编译器。复合 graph 节点按隔离栈语义设计，但第一轮 runtime 可以先显式报错，避免假装支持子图。先把类型契约、图校验、路由裁决和执行循环拆成小模块，pi 适配层通过 `NodeContext` 注入。

**Tech Stack:** TypeScript, Vitest, Node.js ESM.

---

## File Structure

- Create `package.json`: 项目脚本和开发依赖。
- Create `tsconfig.json`: TypeScript 编译配置。
- Create `src/validate.ts`: 静态图校验，不执行节点。
- Create `src/router.ts`: RouterStrategy 的单边裁决。
- Create `src/runtime.ts`: 单 agent 主循环。
- Create `src/index.ts`: SDK 对外导出入口。
- Create `src/*.test.ts`: 对校验、路由和 runtime 做行为测试。
- Modify `src/type.ts`: 只在实现过程中发现类型缺口时小幅修正。

---

### Task 1: Add TypeScript Test Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Add package scripts**

```json
{
  "name": "pi-loop-graph-extension",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Add tsconfig**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install and verify**

Run: `npm install`

Run: `npm run typecheck`

Expected: TypeScript compiles with no errors.

---

### Task 2: Implement Graph Validation

**Files:**
- Create: `src/validate.ts`
- Create: `src/validate.test.ts`

- [ ] **Step 1: Write validation tests**

Cover these cases:

- graph must have at least one `Entry`
- every `Entry.startNodeId` must exist in `graph.nodes`
- every `NodeRouting.nodeId` must exist
- every `Edge.from` must equal its routing node id
- every non-END `Edge.to` must exist
- every code node should have routing unless it can terminate through a reachable `END` edge after execution

- [ ] **Step 2: Implement API**

```ts
export interface GraphValidationIssue {
  code:
    | "NO_ENTRY"
    | "ENTRY_TARGET_MISSING"
    | "ROUTING_NODE_MISSING"
    | "EDGE_FROM_MISMATCH"
    | "EDGE_TARGET_MISSING"
    | "NODE_ROUTING_MISSING";
  message: string;
  path: string;
}

export function validateGraph(graph: Graph): GraphValidationIssue[] {
  // Return all issues; do not throw.
}

export function assertValidGraph(graph: Graph): void {
  const issues = validateGraph(graph);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }
}
```

- [ ] **Step 3: Verify**

Run: `npm test -- src/validate.test.ts`

Expected: all validation tests pass.

---

### Task 3: Implement Single-Edge Router

**Files:**
- Create: `src/router.ts`
- Create: `src/router.test.ts`

- [ ] **Step 1: Write router tests**

Cover these cases:

- `first-match` returns the first guarded edge in registration order
- `priority-first` returns the highest priority guarded edge
- no guarded edge returns `null`
- `custom` delegates to `RouterFn`
- `agent-choice` is explicitly rejected in MVP unless a later `NodeContext`-aware router is designed

- [ ] **Step 2: Implement API**

```ts
export function selectEdge(
  routing: NodeRouting,
  completion: NodeCompletion,
  instance: AgentInstance,
): Edge | null {
  const matched = routing.edges.filter((edge) => edge.guard(completion));
  if (matched.length === 0) return null;

  switch (routing.router.kind) {
    case "first-match":
      return matched[0] ?? null;
    case "priority-first":
      return [...matched].sort((a, b) => b.priority - a.priority)[0] ?? null;
    case "custom":
      return routing.router.fn(matched, completion, instance);
    case "agent-choice":
      throw new Error("agent-choice router is not implemented in single-agent MVP");
  }
}
```

- [ ] **Step 3: Verify**

Run: `npm test -- src/router.test.ts`

Expected: all router tests pass.

---

### Task 4: Implement Runtime Main Loop

**Files:**
- Create: `src/runtime.ts`
- Create: `src/runtime.test.ts`
- Modify: `src/type.ts` only if runtime exposes a necessary missing type.

- [ ] **Step 1: Define runtime options and result**

```ts
export interface RunGraphOptions {
  graph: Graph;
  trigger: Trigger;
  background?: Record<string, unknown>;
  globalGoal: string;
  instanceId?: string;
  ctx: NodeContext;
  maxSteps?: number;
}

export interface RunGraphResult {
  instance: AgentInstance;
  lastCompletion: NodeCompletion;
  status: "completed" | "failed" | "cancelled";
}
```

- [ ] **Step 2: Write runtime tests**

Cover these cases:

- Entry receives `trigger + background` and builds the first `NodeInput`
- Edge `migrate.input` becomes the next node's `NodeInput`
- `END` stops the loop after pushing the final frame
- missing matching entry throws a clear error
- missing matching edge throws a clear error
- `maxSteps` stops infinite loops with a clear error
- `AbortSignal` aborted before a node runs returns or throws a cancellation result consistently
- graph node currently throws a clear "not implemented" error

- [ ] **Step 3: Implement `runGraph`**

Main loop outline:

```ts
export async function runGraph(options: RunGraphOptions): Promise<RunGraphResult> {
  assertValidGraph(options.graph);
  const background = options.background ?? {};
  const entry = options.graph.entries.find((item) => item.guard(options.trigger, background));
  if (!entry) throw new Error("No graph entry matched trigger/background");

  const instance: AgentInstance = {
    id: options.instanceId ?? crypto.randomUUID(),
    globalGoal: options.globalGoal,
    background,
    frames: [],
    mechanisms: [],
  };

  let nodeId = entry.startNodeId;
  let input: NodeInput = {
    data: entry.input?.(options.trigger, background) ?? {},
    source: { kind: "entry", entryId: entry.id },
  };

  for (let step = 0; step < (options.maxSteps ?? 100); step += 1) {
    if (options.ctx.signal.aborted) {
      throw new Error("Graph execution aborted");
    }

    const node = options.graph.nodes[nodeId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const completion =
      node.kind === "code"
        ? await node.execute(instance, input, options.ctx)
        : await runSubGraphNode(node, instance, input, options.ctx);

    const routing = options.graph.routing[nodeId];
    if (!routing) throw new Error(`Routing not found for node: ${nodeId}`);

    const edge = selectEdge(routing, completion, instance);
    if (!edge) throw new Error(`No edge matched completion for node: ${nodeId}`);

    const migration = edge.migrate(instance, completion);
    instance.frames.push(migration.frame);

    if (edge.to === END) {
      return { instance, lastCompletion: completion, status: completion.status };
    }

    nodeId = edge.to;
    input = {
      data: migration.input ?? {},
      source: { kind: "edge", edgeId: edge.id, fromNodeId: edge.from },
    };
  }

  throw new Error("Graph execution exceeded maxSteps");
}
```

- [ ] **Step 4: Defer subgraph implementation cleanly**

For MVP, `runSubGraphNode` may throw:

```ts
throw new Error("Graph node execution is not implemented in single-agent MVP");
```

Do not silently treat graph nodes as code nodes.

- [ ] **Step 5: Verify**

Run: `npm test -- src/runtime.test.ts`

Run: `npm run typecheck`

Expected: tests and typecheck pass.

---

### Task 5: Export SDK Surface

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Export stable modules**

```ts
export * from "./type.js";
export * from "./validate.js";
export * from "./router.js";
export * from "./runtime.js";
```

- [ ] **Step 2: Verify import surface**

Add a small test importing `runGraph`, `validateGraph`, `END`, and `Graph` from `./index.js`.

Run: `npm test`

Expected: all tests pass.

---

### Task 6: Add Isolated Subgraph Runtime

**Files:**
- Modify: `src/runtime.ts`
- Modify: `src/runtime.test.ts`

- [ ] **Step 1: Write subgraph isolation tests**

Cover these cases:

- child graph receives `background = parent NodeInput.data`
- child graph starts with `frames = []`
- child graph cannot read parent `frames`
- child END result becomes parent graph node's `NodeCompletion`
- parent Edge decides how to fold that graph-node completion into parent frames

- [ ] **Step 2: Implement child instance creation**

Runtime rule:

```ts
const childBackground = input.data;
const childInstance: AgentInstance = {
  id: crypto.randomUUID(),
  globalGoal: `${instance.globalGoal}\n\nSubgoal: ${node.subGoal}`,
  background: childBackground,
  frames: [],
  mechanisms: instance.mechanisms,
};
```

The child runtime must not receive `instance.frames`.

- [ ] **Step 3: Reduce child result to parent completion**

Use a small reducer first:

```ts
return {
  nodeId: node.id,
  status: childResult.status,
  result: {
    childGraphId: node.graph.id,
    childFrames: childResult.instance.frames,
    childResult: childResult.lastCompletion.result,
  },
};
```

This is intentionally conservative: parent graph sees the child summary as one structured result, and parent Edge chooses what to preserve.

- [ ] **Step 4: Verify**

Run: `npm test -- src/runtime.test.ts`

Run: `npm run typecheck`

Expected: subgraph tests pass, and parent `instance.frames` only grows by the parent graph node's selected Edge.migrate frame.

---

## Deferred On Purpose

- Multi-agent frames, fork/join, and `all-satisfied`
- Communication bus runtime
- Declarative JSON compiler
- Result schema/generic typing
- Custom graph-node result reducers beyond the conservative default
- `agent-choice` router, unless it is redesigned to receive runtime capability context

---

## Next Review Gate

After Task 4 passes, revisit `src/type.ts` for two decisions:

1. Whether `RouterStrategy` should remove `agent-choice` from MVP entirely instead of throwing.
2. Whether `NodeCompletion.result` and `MigrationResult.input` should gain schema or generic typing before public SDK release.
