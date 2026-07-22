# 内部协议：Mechanism Runtime

> 维护者文档。实现见 `src/runtime/mechanism-runtime.ts`、`src/core/mechanism.ts`。

## 三层 Scope 管理

`MechanismRuntime.open(installation, scopeId, definitions, identity)` 创建 MechanismChain：

- `installation: "host"` → state 生命周期 = Root Run
- `installation: "graph"` → state 生命周期 = Graph Invocation
- `installation: "node"` → state 生命周期 = Node Visit

同一活跃链重复安装（除非 `allowMultiple`）。

## Hook 执行顺序

```text
open（createState）→ enter（onRootEnter / onGraphEnter / onNodeEnter）
  → beforeAgentRun
  → [Agent Run 内部：LLM turns → validateCompletion]
  → afterAgentRun
→ exit（onNodeExit / onGraphExit / onRootExit）
  → close（cleanup LIFO）
```

进入：Host → Graph → Node。退出和控制：Node → Graph → Host。

`beforeAgentRun` 前注入 `naturalLifetime: "agent-run"`，结束后清除。

## State 管理

每个 Invocation 持有独立的 `context.state`（来自 `createState()`）。同一 Node Visit 内多次 `runAgent()` 共享 Node Mechanism state。

`snapshot()` / `restore()` 提供 JSON-compatible 快照。`snapshotAll()` 和 `restoreState()` 用于 checkpoint。

## Context Contribution

`ctx.context.add` 写入 Context State，按 `installation` 限制 maxLifetime。scope 退出时自动清理。

## 执行沙箱

`ctx.exec.run(file, args, options)` 在 execRoot、超时和输出字节预算约束下执行外部命令。

## 源码引用

- `src/core/mechanism.ts` — Mechanism 类型和 defineMechanism
- `src/runtime/mechanism-runtime.ts` — MechanismRuntime 完整实现
- `src/runtime/graph-runtime.ts` — GraphRuntime 中 mechanism scope 的 open/enter/close
- 测试：`tests/runtime/phase5-mechanisms.test.ts`
