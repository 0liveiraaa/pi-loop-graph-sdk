# 控制节点可用工具

## 适用场景

你需要精确控制每个节点中 LLM 能调用哪些 pi 工具。这涉及节点级白名单、全局默认工具、运行时解析以及机制层的工具门禁。

## 最小代码

### 1. 节点级工具白名单

```typescript
import { createAgentExecute } from "pi-loop-graph-sdk";
import type { Mechanism, Node } from "pi-loop-graph-sdk";

const reviewNode: Node = {
  kind: "code",
  id: "review",
  subGoal: "出题并批改",
  tools: ["review_chapter", "review_card", "review_answer"],
  execute: createAgentExecute(),
};

const summaryNode: Node = {
  kind: "code",
  id: "summary",
  subGoal: "生成总结",
  // 不声明 tools → 使用默认工具集
  execute: createAgentExecute(),
};
```

声明 `tools` 的节点，LLM 可用的工具为：`read` + 默认工具 + 该节点声明列表 + `__graph_complete__`（去重，read 强制首位）。

### 2. 全局默认工具

```typescript
import { createLoopGraphExtension } from "pi-loop-graph-sdk";

const loop = createLoopGraphExtension(pi, {
  defaultTools: ["review_card", "review_chapter"],
});
```

全局默认工具会与节点声明的工具合并，而不是被节点配置覆盖。SDK 还会补上框架运行必需的工具。

### 3. 按图/节点动态解析工具

```typescript
const loop = createLoopGraphExtension(pi, {
  toolResolver({ defaultTools, nodeTools, graphId, nodeId }) {
    if (graphId === "admin") {
      // 管理类图允许所有工具
      return [...defaultTools, ...nodeTools, "bash", "write"];
    }
    if (nodeId === "sensitive") {
      // 敏感节点只允许只读工具
      return ["read"];
    }
    return [...defaultTools, ...nodeTools];
  },
});
```

`toolResolver` 的返回值同样会被 SDK 强制保留 `read` 和 `__graph_complete__`。同一个 resolver 同时用于首次工具校验和实际设置。

### 4. 机制层工具门禁（beforeToolCall / afterToolResult）

当需要在工具执行前后做拦截或脱敏时，使用机制：

```typescript
const safeGuard: Mechanism = {
  name: "safe-guard",

  // 工具调用前拦截
  beforeToolCall(ctx) {
    if (ctx.event.toolName !== "read") return { action: "allow" };

    // 只允许读取 docs 目录
    if (!String(ctx.event.input.path).startsWith("docs/")) {
      return { action: "deny", reason: "只允许读取 docs 目录" };
    }
    return { action: "allow" };
  },

  // 工具结果返回后脱敏
  afterToolResult(ctx) {
    if (ctx.event.toolName === "read" && containsSecret(ctx.event.content)) {
      return {
        action: "replace",
        content: [{ type: "text", text: "[内容已脱敏]" }],
      };
    }
    return { action: "keep" };
  },
};
```

机制注册到 `Graph.mechanisms`（全局生效）或 `Node.mechanisms`（仅该节点生效）。

### 工具决策一览

| 决策 | 适用 Hook | 效果 |
| --- | --- | --- |
| `{ action: "allow" }` | beforeToolCall | 允许调用原参数 |
| `{ action: "deny", reason: "..." }` | beforeToolCall | 拒绝调用，reason 告知 LLM |
| `{ action: "patch", input: {...} }` | beforeToolCall | 修改参数后调用（需 schema 校验） |
| `{ action: "keep" }` | afterToolResult | 保留原始结果 |
| `{ action: "replace", content: [...] }` | afterToolResult | 替换 LLM 可见的内容 |

## 运行顺序

1. 节点进入时，SDK 调用 `resolveNodeTools(defaultTools, node.tools)`（如有 `toolResolver` 则由其接管）。
2. 结果强制补上 `read` 和 `__graph_complete__`。
3. 工具集通过 `setActiveTools()` 生效。
4. 每次 LLM 调用工具前，按机制注册顺序依次执行 `beforeToolCall`。拒绝或补丁按机制顺序组合。
5. 工具执行后，按同样顺序执行 `afterToolResult`。

> `__graph_complete__` 不经过 `beforeToolCall` 的一般补丁流程。

## 安全边界与常见错误

- **不要使用已过时的 `runAgent().tools`**：工具白名单必须通过 `Node.tools` 声明。
- **不要假设 `node.tools` 是完整工具集**：`read` 和 `__graph_complete__` 始终存在。
- **`beforeToolCall` 的 patch 受 schema 约束**：如果工具的参数 JSON Schema 无法验证补丁后的参数，patch 会被拒绝。
- **`afterToolResult` 只能替换 `content` 和 `isError`**：不能修改工具的元数据字段。
- **工具门禁中的异步操作要及时完成**：长时间阻塞可能触发 agent run 超时。

## 相关概念

- [混合代码与 Agent](mix-code-and-agent.md) — Node 声明与 execute 模式
- [机制 Hooks](mechanism-hooks.md) — beforeToolCall/afterToolResult 的完整生命周期
- [自动验证](automatic-validation.md) — 配合工具控制做完成度校验
