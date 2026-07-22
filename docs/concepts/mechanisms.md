# Mechanism：围绕节点工作的横切扩展

Mechanism 用于把工具审计、自动验收、计时、资源清理等横切能力附加到图运行过程，而不把这些逻辑复制到每个 Node 中。

## 三层安装

```text
Host Mechanism   → 整个 Root Run，不可被调用边界绕过
  Graph Mechanism → 当前图，子图有自己的 Graph Mechanism
    Node Mechanism → 当前 Node Visit
```

父图 Graph Mechanism 不自动进入子图。call、compose、delegate 均运行被调用图自身的 Graph Mechanism。

## 定义 Mechanism

```typescript
import { defineMechanism } from "pi-loop-graph-sdk";

const auditMechanism = defineMechanism({
  name: "audit-log",
  failurePolicy: "continue", // Node 默认 "fail-node"，Graph/Host 默认 "fail-graph"

  // 可选：创建私有 state（每次安装 scope 一份）
  createState: () => ({ count: 0 }),

  // ── 进入/退出 hooks ──
  onGraphEnter(ctx) {
    ctx.state.count++;
    ctx.context.add("enter-notice", "审计已启动", {
      lifetime: "graph-invocation",
      retention: "sticky",
    });
  },

  onNodeEnter(ctx) {
    // ctx.scope.onCleanup 注册清理，scope 退出自动执行
    ctx.scope.onCleanup(() => console.log("node done"));
  },

  // ── Agent Run hooks ──
  beforeAgentRun(ctx) {
    ctx.context.add(`run-guide`, "请只提交 Output Contract 要求的字段", {
      lifetime: "agent-run",
      retention: "sticky",
    });
  },

  // ── Completion gate ──
  validateCompletion(ctx) {
    if (!ctx.completion) {
      return { action: "reject", reason: "缺少 completion" };
    }
    return { action: "allow" };
  },
});
```

## Hook 顺序

进入：**Host → Graph → Node**

退出：**Node → Graph → Host**

Agent Run 控制 Hook 在 beforeAgentRun → validateCompletion 之间。Host 的 validateCompletion 拥有最终否决权。

## 可用 Hook

| Hook | 触发时机 | 能力 |
|------|----------|------|
| `onRootEnter` / `onRootExit` | Root 开始/结束 | 全局审计、记录 |
| `onGraphEnter` / `onGraphExit` / `onGraphError` | 图调用开始/结束/错误 | 图级横切 |
| `onNodeEnter` / `onNodeExit` / `onNodeError` | 节点访问开始/结束/错误 | 节点级横切 |
| `beforeAgentRun` / `afterAgentRun` | 每次 runAgent 前后 | 追加 prompt、记录 |
| `validateCompletion` | Agent 提交结果后 | 验收门 |

## State 生命周期

| 安装位置 | State 生命周期 |
|----------|---------------|
| Host | 每次 Root Run 一份 |
| Graph | 每次 Graph Invocation 一份 |
| Node | 每次 Node Visit 一份 |

同一 Node Visit 内多次 `runAgent()` 共享 Node Mechanism state。再次访问同一节点创建新 state。

`createState()` 懒初始化。可选的 `snapshot()` / `restore()` 支持 checkpoint 持久化。

## Context Contribution

通过 `ctx.context.add(key, content, { lifetime, retention })` 写入：

```typescript
onNodeEnter(ctx) {
  const handle = ctx.context.add("guide", "当前阶段的安全要求", {
    lifetime: "node-visit",   // max: 安装 scope
    retention: "sticky",      // sticky | foldable | transient
  });
  // handle.update(newContent)  // 更新内容
  // handle.dispose()           // 手动删除
}
```

不能创建比安装 scope 更长的 contribution。

## exec sandbox

`ctx.exec.run(file, args, { cwd?, timeoutMs? })` 在受控根目录和超时下执行外部命令。输出自动按字节预算截断。

## 失败策略

| failurePolicy | 抛错后行为 |
|---------------|-----------|
| `"continue"`（默认） | 记录并继续 |
| `"fail-node"` | 节点失败，走路由 |
| `"fail-graph"` | 图终止 |

控制 Hook（beforeAgentRun、validateCompletion）默认 fail-closed。观察 Hook（onNodeEnter、afterAgentRun 等）默认记录后继续。onNodeError 自身抛错不改变失败策略。

## 相关文档

- [Mechanism 生命周期与清理](../guides/mechanism-hooks.md) — 实操指南
- [内部：Mechanism Runtime](../internals/mechanism-runtime.md) — 实现协议
