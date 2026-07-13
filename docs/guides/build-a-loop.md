# 构建条件路由与跨阶段循环

## 适用场景

你需要一个节点在完成后根据结果走向不同的下一阶段，或者让某个节点在失败/不满足条件时回到自身重试，形成循环。

## 最小代码

以下图在批改结果不通过时让 `grade` 节点自环重试，通过后走向 `summary`：

```typescript
import { END, createAgentExecute } from "pi-loop-graph-sdk";
import type { Edge, Graph, Node, Entry } from "pi-loop-graph-sdk";

const gradeNode: Node = {
  kind: "code",
  id: "grade",
  subGoal: "批改用户答案并给出评分",
  execute: createAgentExecute(),
};

const summaryNode: Node = {
  kind: "code",
  id: "summary",
  subGoal: "总结本轮复习情况",
  execute: createAgentExecute(),
};

// 失败 → 回到自身
const retryEdge: Edge = {
  id: "grade_retry",
  from: "grade",
  to: "grade", // 自环
  priority: 10,
  guard: (c) => c.status === "failed",
  migrate(instance, completion) {
    return {
      frame: {
        gradingAttempt: { outcome: "retry", details: completion.result },
      },
      input: { retry: true },
    };
  },
};

// 成功 → 进入下一阶段
const nextEdge: Edge = {
  id: "grade_to_summary",
  from: "grade",
  to: "summary",
  priority: 5,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        gradingOutcome: { score: completion.result.score, details: completion.result },
      },
      input: { score: completion.result.score },
    };
  },
};

// 结束
const endEdge: Edge = {
  id: "summary_to_end",
  from: "summary",
  to: END,
  priority: 10,
  guard: (c) => c.status === "ok",
  migrate(instance, completion) {
    return {
      frame: {
        reviewOutcome: completion.result,
      },
    };
  },
};

const entry: Entry = {
  id: "main",
  guard: () => true,
  startNodeId: "grade",
};

export const reviewGraph: Graph = {
  id: "review_loop",
  goal: "带重试循环的复习图",
  entries: [entry],
  nodes: { grade: gradeNode, summary: summaryNode },
  routing: {
    grade: {
      nodeId: "grade",
      edges: [retryEdge, nextEdge],
      router: { kind: "first-match" },
    },
    summary: {
      nodeId: "summary",
      edges: [endEdge],
      router: { kind: "first-match" },
    },
  },
};
```

## 运行顺序

1. 图从 `grade` 节点进入，LLM 完成批改后调用 `__graph_complete__`，生成 `NodeCompletion`（状态为 `ok` 或 `failed`）。
2. 路由系统按 `edges` 数组顺序检查每条边的 `guard`。
3. 若 `guard(completion)` 返回 `true`，执行该边的 `migrate`，生成下一节点的输入并将工作记忆帧推入帧栈。
4. 下一节点按同样流程继续，直到某条边的 `to` 为 `END` 时图终止。

循环的关键是 `to` 指向当前节点自身，`guard` 负责判断是否需要重试。

## 路由策略

`routing` 中的 `router` 决定边的选择方式：

| 策略 | 行为 |
| --- | --- |
| `{ kind: "first-match" }` | 按 edges 数组顺序取第一条 guard 返回 true 的边 |
| `{ kind: "priority-first" }` | 按 priority 值从高到低排序，同级按数组顺序 |
| `{ kind: "agent-choice" }` | LLM 在 `__graph_complete__` 时通过 `result.chosen_edge_id` 决定走哪条边 |
| `{ kind: "custom"; fn }` | 自定义选择函数，返回选中的 Edge 或 null |

`agent-choice` 适用于让 LLM 自己判断下一步走向的场景。如果 LLM 未声明或声明了不存在的边，框架会让 LLM 重试；`priority-first` 仅在该情况下作为兜底。

## 无边匹配时

使用 `first-match` 或 `priority-first` 时，如果所有边的 `guard` 都返回 `false`，当前运行会结束而不是抛出异常。若“无匹配”在业务上代表错误，应显式准备兜底边。

## 安全边界与常见错误

- **死循环**：自环节点必须有明确的退出条件（guard 区分 ok/failed，或设置最大重试次数由 `migrate` 递减计数器）。超过 `rootMaxSteps`（默认 100）时图自动终止。
- **guard 只读 NodeCompletion**：不要在 guard 中修改状态或调用外部 API。guard 会被多次求值。
- **router 与 edges 的顺序**：`first-match` 依赖于数组顺序；把更具体的条件（如 `status === "failed"`）放在前面。
- **工作记忆不是数据通道**：`frame` 是给后续阶段参考的记忆，结构由你的业务定义；`input` 才是传给下一节点的数据。

## 相关概念

- [Graph 与 Node 模型](../concepts/glossary.md)
- [子图调用](call-subgraphs.md) — 当你需要跨图实现更大循环时
- [验证](automatic-validation.md) — 配合 `validateCompletion` 让 agent-choice 更可靠
