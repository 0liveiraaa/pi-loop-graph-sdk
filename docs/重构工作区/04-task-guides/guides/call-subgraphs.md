# 调用子图：call、compose 与 delegate

## 适用场景

你需要把一张 Graph 当作节点嵌入另一张 Graph 执行。三种边界提供不同的共享与隔离程度。

## 最小代码

### call（默认）：独立工作区

```typescript
import { END, createAgentExecute } from "pi-loop-graph-sdk";
import type { Graph, Node } from "pi-loop-graph-sdk";

// 子图定义
const childGraph: Graph = {
  id: "price_check",
  goal: "价格复核",
  entries: [{ id: "main", guard: () => true, startNodeId: "check" }],
  nodes: {
    check: {
      kind: "code",
      id: "check",
      subGoal: "核实价格",
      execute: createAgentExecute(),
    },
  },
  routing: {
    check: {
      nodeId: "check",
      edges: [{ id: "done", from: "check", to: END, priority: 10, guard: () => true, migrate: (_, c) => ({ frame: {} }) }],
      router: { kind: "first-match" },
    },
  },
};

// 父图中引用（缺省 boundary 即为 call）
const parentNode: Node = {
  kind: "graph",
  id: "call_price",
  subGoal: "委托价格复核",
  graph: childGraph,
};
```

### compose：共享工作记忆

```typescript
const inlineNode: Node = {
  kind: "graph",
  id: "modify_document",
  subGoal: "修改文档（内部拆为阅读→计划→编辑→复查）",
  graph: documentEditGraph,
  boundary: "compose",
  fold: ({ segment, finalResult }) => ({
    status: finalResult.status,
    result: {
      edited: finalResult.result,
      completedStepCount: segment.length,
    },
  }),
};
```

### delegate：独立执行会话

```typescript
const isolatedNode: Node = {
  kind: "graph",
  id: "long_migration",
  subGoal: "长任务代码迁移",
  graph: migrationGraph,
  boundary: "delegate",
};
```

这里假设 `documentEditGraph` 和 `migrationGraph` 是已经定义并通过校验的图。delegate 还需要在创建扩展时通过 `createDelegateHost` 提供独立执行环境的工厂，否则校验会明确报错。

## 三种边界对比

| | call（默认） | compose | delegate |
| --- | --- | --- | --- |
| 执行会话 | 复用父级 | 复用父级 | 新建独立 Session |
| 逻辑工作实例 | 新建 | 复用父级 | 新建 |
| 能否读取父级 frames | 否 | 是 | 否 |
| 机制 state | 新建 | 复用 | 新建 |
| 子图返回方式 | 状态和结果 | fold 归约临时帧段 | GraphRunResult |
| 上下文压缩 | 共享会话限制跨越边界 | 同 call | 独立生命周期 |

## 如何选择

按顺序回答：

1. 子图是否必须使用独立 AgentSession（例如长任务需要独立压缩）？→ **delegate**
2. 子图是否必须读取父图已完成的 frames，或需要作为父节点的内部实现展开？→ **compose**
3. 以上都不需要 → **call**

常见误区：

| 误区 | 事实 |
| --- | --- |
| "代码复用就应该用 compose" | 代码复用不等于共享工作记忆。只需要输入输出契约时，call 更清晰。 |
| "call 会创建新 Session" | call 只创建新的 AgentInstance，仍复用当前 Session。 |
| "delegate 等于并行" | delegate 允许独立 host 承载，但当前图运行仍沿单一路径等待结果。 |
| "compose 的子图 frames 会自动保留到父图" | compose 的临时帧段必须通过 fold 归约。父图只看到 graph node 对外提交的完成结果。 |

## 输入与返回

无论哪种边界，都只通过明确的 `background` 向子图传递数据，不要依赖闭包或模块变量。

返回时：
- **call** 和 **delegate**：不把子图 frames 带回父图，只返回最终状态和结果。
- **compose**：子图运行时产生临时帧段，退出时必须通过 `fold` 归约为一条完成记录。后续是否保存为长期工作记忆，仍由父图离开该 graph node 时选中的边决定。

## 安全边界

- **compose 必须提供 `fold`**：没有 fold 则子图内部帧段无法归约，框架会在校验期报错。
- **call 和 delegate 不需要也不能提供 `fold`**：声明 `fold` 会在校验期报错。
- **不要用闭包传递图间业务数据**：节点函数仍可能捕获 JavaScript 模块变量，但 Runtime 不会隔离、记录或验证这些数据。正式数据应通过 `background` 输入传递。

## 相关概念

- [子图边界概念](../../设计/CONTEXT.md)
- [构建循环](build-a-loop.md) — 在图内实现单节点循环
- [上下文自定义](customize-context.md) — 子图进入时的上下文渲染
