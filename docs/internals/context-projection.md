# 内部协议：上下文投影与恢复

> 维护者文档。实现见 `src/core/context.ts`、`src/runtime/graph-runtime.ts`。

## 目标

模型上下文只从结构化 Context State 生成，不再把 Session messages 当稳定真相源。

## Context State

`ContextState`（`src/core/context.ts`）维护结构化 contribution：

```typescript
interface ContextContribution {
  id: string;
  owner: "host" | "graph" | "node" | "agent-run" | "runtime";
  scopeId: string;
  lifetime: ContextLifetime;    // agent-run | node-visit | graph-invocation | root-run
  retention: ContextRetention;  // sticky | foldable | transient
  content: ContextContent;
}
```

每次 LLM call 前，Context Runtime 读取当前活跃 scopes，按固定顺序组装 contribution → 生成不可变 ContextSnapshot。

## 投影管线

GraphRuntime 在每次 Agent Run 前调用 `contextState.materializeNode()`：

```text
Graph goal + Background（Graph Invocation 物化一次，冻结）
→ Memory（Frame revision 变化后重新物化，缓存）
→ Node subGoal + Focus + Connections + Skills（Node Visit 物化一次，冻结）
→ Mechanism contributions（按 scope 过滤）
→ Output Contract（Agent Run scope，protected）
```

纯 Code Node（未调用 `runAgent()`）不生成模型快照。

## 快照重投影

compaction 后，Pi `context` hook 中移除旧 canonical snapshot 并重投影当前 Graph/Memory/Node 层。sticky contribution 不依赖 summary；foldable 可进入压缩摘要；transient 下次 call 后删除。

## Output Contract 恢复

Output Contract 有独立恢复路径。compaction 后 context hook 强制补回活动 contract。Agent Run 结束后立即删除。

## 源码引用

- `src/core/context.ts` — ContextState、ContextContribution、materializeProjection
- `src/runtime/graph-runtime.ts` — materializeNode、refreshSnapshot
- `src/adapter/pi-node-context.ts` — Pi context hook 集成
- 测试：`tests/runtime/phase4-context.test.ts`
