# 内部协议：运行时边界

> 维护者文档。实现见 `src/runtime/graph-runtime.ts`、`src/host/graph-host.ts`。

## 两个正交维度

图调用来源（command、tool、graph-node、api）和调用边界（call、compose、delegate）是正交的。来源不隐式决定边界。

## RootRunState

`GraphRuntime.execute()` 创建 `RootRunState`：

```typescript
interface RootRunState {
  rootRunId: string;
  budget: InvocationBudget;  // 共享预算
  signal?: AbortSignal;
  baseline: HostBaseline;
}
```

## GraphInvocationState

每次 `runInvocation()` 创建 `GraphInvocationState`：

```typescript
interface GraphInvocationState {
  graphInvocationId: string;
  rootRunId: string;
  parentGraphInvocationId?: string;
  graph: GraphRef;
  boundary: InvocationBoundary;
  depth: number;
  frames: JsonValue[];
  frameRevision: { value: number };
}
```

## Call/Compose: Invocation-Scoped Session

Phase 7.1 引入 `createInvocationAgentHost` 协议。call/compose 子图中的 Agent Run 使用**临时 Pi child Session**：

- `GraphRuntimeHost.createInvocationAgentHost({ root, invocation })` → 返回 `{ runAgent, dispose }`
- child Session 生命周期绑定 Graph Invocation
- 同一个 Core GraphRuntime 管理 Root budget、调用谱系、Frames、Mechanism 和 Recorder
- child Session 继承 Host 配置（cwd、model、认证、baseline、工具实现、recording sink）
- **不继承**父 Session transcript、compaction summary 或活动 Output Contract
- compose 的 Frames 共享通过 Core Runtime 的显式 Memory，不通过 Session messages

## Delegate

delegate 创建独立 Host/Session。通过 `GraphRuntimeHost.delegateGraph` hook 实现。不在同一 callStack 中运行。

## Checkpoint/Resume

Phase 10 实现：Transition 完成、下一 Node 未开始时原子写 checkpoint（`runtime/writeNodeCheckpoint`）。Resume 从 `CheckpointStore` 读取最新 checkpoint、重建状态、跳转到 checkpointed Stage。当前仅单层 root invocation 支持；嵌套 invocation stack 数据结构已就绪。

## 源码引用

- `src/runtime/graph-runtime.ts` — 全部状态机
- `src/runtime/invocation-budget.ts` — InvocationBudget
- `src/host/graph-host.ts` — createGraphHost、resume
- `src/replay/checkpoint.ts` — checkpoint 协议
- 测试：`tests/runtime/`、`tests/host/`、`tests/replay/phase10-checkpoint.test.ts`
