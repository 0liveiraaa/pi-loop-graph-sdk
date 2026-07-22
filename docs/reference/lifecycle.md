# 生命周期参考

## 图级生命周期

```text
root_started
  → host_baseline_selected
  → [graph_entered → graph_exited] × N
  → root_finished
```

## 节点生命周期

```text
node_entered
  → onNodeEnter（Mechanism hooks：Host → Graph → Node）
  → Context Snapshot 物化
  → [Agent Run] × N
      → beforeAgentRun
      → output contract 注入（sticky，protected）
      → [LLM turn]
          → model_turn_started
          → [工具调用]
              → tool_execution_started → tool_execution_finished
          → model_turn_finished
      → __graph_complete__ 提交
      → 验证链（outputSchema → route → node → mechanism → agent-choice）
          → rejected → 下一轮 LLM turn
          → accepted → Agent Run 完成
      → afterAgentRun
  → onNodeExit（Mechanism：Node → Graph → Host）
  → Route 选择 Connection
  → Transition（frame → map/output）
  → node_exited
```

## 验证链顺序

```text
outputSchema（Agent Run Output Contract 校验）
  → Agent Run validator
    → Node validator
      → Route structure 检查
        → Mechanism validateCompletion（Node → Graph → Host）
          → agent-choice 结构检查
```

每层失败后后续层不执行。全部通过 → Agent Run 完成。

## 子图生命周期

```text
graph_entered（子图）
  → [子节点 × N]
  → graph_exited（子图）
→ 父图继续
```

call/compose 子图中的 Agent Run 使用临时 child Session。子图返回、失败或取消后 child Session 自动 abort/dispose。

## Mechanism Scope 生命周期

```text
Host scope 打开（Root Run 开始）
  Graph scope 打开（Graph Invocation 开始）
    Node scope 打开（Node Visit 开始）
      Agent Run scope（每次 runAgent）
    Node scope 关闭（cleanup LIFO）
  Graph scope 关闭
Host scope 关闭
```

## Cleanup 顺序

1. scope 取消信号触发
2. 按注册逆序（LIFO）执行 onCleanup
3. 每个 cleanup 抛错不阻止后续 cleanup

## 相关文档

- [错误与限制](errors-and-limits.md) — failurePolicy、超时
- [Mechanism](../concepts/mechanisms.md) — Hook 顺序
