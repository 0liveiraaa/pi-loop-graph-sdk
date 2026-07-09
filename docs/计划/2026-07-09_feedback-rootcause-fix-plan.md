# 2026-07-09 反馈根因修复计划（v2 — 经 pi API 核实）

> 基于 `docs/审查/loop-graph-sdk-feedback.md` 根因研判 + pi API 逐接口核实。
> v1 被否决：阶段 3/4 对 pi API 的假设不成立（role 字段、turn_error 事件、自建 skill loader）。
> v2 所有方案落在真实 pi API 上。

---

## 阶段 1：装配收敛 + 观测分叉修复（治本）

### 1.1 拆出单一工具解析函数

**新建** `src/tools-resolve.ts`：

```typescript
export function resolveNodeTools(
  defaultTools: string[],
  nodeTools: string[],
): string[] {
  const merged = ["read", ...defaultTools, ...nodeTools, "__graph_complete__"];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of merged) {
    if (!seen.has(t)) { seen.add(t); result.push(t); }
  }
  return result;
}
```

全仓库只有这一个函数产出最终工具列表。根治问题 2（无去重）和问题 1 的 debug log 分叉。

### 1.2 修改 setNodeToolsForInstance

`loop-graph-extension.ts:410-416` → 调用 `resolveNodeTools`：

```typescript
function setNodeToolsForInstance(piInner: ExtensionAPI, node: Node): void {
  const nodeTools = node.kind === "code" ? (node.tools ?? []) : [];
  piInner.setActiveTools(resolveNodeTools(defaultTools, nodeTools));
}
```

### 1.3 修改 debug 日志 — 读真值，不手工重建

`loop-graph-extension.ts:201-205`：

```typescript
setNodeToolsForInstance(piInner, node);
// 读 pi 实际生效的工具集，而非手工重建一份不包含 defaultTools 的数组
const actualTools = piInner.getActiveTools();
debugLog.toolsChanged(nodeId, actualTools);
```

观测 = 真相。根治 debug log 造假问题。

### 1.4 废弃 createAgentExecute 的 tools 参数

- `agent-execute.ts`：`tools` 字段标注 `@deprecated`
- `PiNodeContext.runAgent`：不消费 `request.tools`
- `AgentRunRequest.tools` 保留类型声明但注 `@deprecated`，不 break 调用方

### ~~1.5~~ 删除

上一版试图把 `setActiveTools` 挪进 `runAgent`。越界了——`runAgent` 拿不到 `node`，硬塞违反宪法原则 2（隐式全局状态）。保持现有分工：主循环设工具，`runAgent` 只管 prompt + 等待。

---

## 阶段 2：注册期工具校验（预防）

### 2.1 注册期去重检查

`GraphRegistry.registerGraph` 中遍历所有 `kind: "code"` 节点，对 `resolveNodeTools(defaultTools, node.tools)` 做内部去重检查。如有重复 → 立即抛可读错误，指名节点和冲突工具名。

### 2.2 工具存在性校验 — 用真实的 pi.getAllTools()

`pi.getAllTools()` 返回 `ToolInfo[]`（含 `name`、`description`、`parameters`、`promptGuidelines`、`sourceInfo`）。用它做存在性校验，不再延后。

**时序问题**：`registerGraph` 可能在 `pi.registerTool` 之前被调用。校验时机改为 **首次 `executeGraph`**（或 `session_start` 后），此时工具已全部注册。在校验函数中对比 `defaultTools ∪ node.tools` 与 `getAllTools()` 结果 — 不存在的工具名当场抛错。

### 2.3 校验函数

`validate.ts` 新增 `validateGraphTools(graph, defaultTools, registeredToolNames: Set<string>)`：

```typescript
export function validateGraphTools(
  graph: Graph,
  defaultTools: string[],
  registeredNames: Set<string>,
): void {
  for (const node of Object.values(graph.nodes)) {
    if (node.kind !== "code") continue;
    const tools = resolveNodeTools(defaultTools, node.tools ?? []);
    for (const t of tools) {
      if (!registeredNames.has(t)) {
        throw new Error(
          `图 "${graph.id}" 节点 "${node.id}" 引用了未注册的工具: "${t}"`,
        );
      }
    }
  }
}
```

---

## 新增宪法原则：追加不注入

**SDK 永远不修改 system prompt。** 所有上下文操作只能在进入图的**消息流追加侧**进行。

- 禁止使用 `before_agent_start` 替换 `systemPrompt`
- 当前已有的追加式操作（projection 钩子向消息流追加 COMPLETED / CURRENT 段）是唯一合法模式
- 追加大于注入（append > inject）

此原则写入 Agent.md 第三节。

---

## 阶段 3：skill 落地 + 问题 1 定论

### 3.1 问题 1 live 验证

**用 `before_provider_request` 事件看真相**。

`before_provider_request`（`types.d.ts:494`）携带 `payload: unknown` — 这是真正发给模型的那一份请求体，里面的 `tools` 数组就是最终答案。

验证方法：在 SDK 的 extension 中挂一个临时的 `before_provider_request` 监听，skill 节点进入时，打印 `(payload as any).tools` 中的所有工具名。对比 `setActiveTools` 设定的值。

- 如果一致 → 问题 1 是 debug log 造假，阶段 1.3 即可关闭
- 如果不一致 → pi 的 skill turn 机制覆盖了 `setActiveTools`，需进一步排查 pi 侧行为

### 3.2 skill — 接入 pi 原生 + 追加式注入

**决策**：走方案 A（接入 pi 原生 skill 系统），但**不动 system prompt**。

#### 3.2.1 注册 skill 路径（pi 原生机制）

在 `createLoopGraphExtension` 中挂 `resources_discover` 事件，让业务 skill 目录被 pi 发现：

```typescript
pi.on("resources_discover", (_event) => {
  return { skillPaths: [options.skillBasePath ?? path.join(process.cwd(), "skills")] };
});
```

pi 自动扫描目录、提取 frontmatter、在系统提示中以 XML 渐进式披露 skill 的 name + description。**这是 pi 自己的行为，不是 SDK 修改 system prompt。**

#### 3.2.2 节点进入时追加完整 skill 内容

当节点声明了 `node.skill`，SDK 在**进入节点时**读取对应的 `SKILL.md`，将其完整内容**追加**到消息流中——和 COMPLETED / CURRENT 段同样的追加模式：

- 读取文件发生在主循环的 `setNodeToolsForInstance` 之后、`sendMessage(marker)` 之前
- 将 skill 内容作为一条独立的 `sendUserMessage` 追加，或拼入 CURRENT 段的 `skill:` 区域
- 不动 system prompt，不走 `before_agent_start`

**skill 路径解析**：`node.skill = "review-question"` → 在 `skillBasePath` 下查找 `review-question/SKILL.md`。

#### 3.2.3 修改 type 注释

`type.ts` 中关于 skill 的注释从"落地为将 skill 文本注入系统提示"改为：

```
skill 关联的 skill 名称。节点进入时，对应的 SKILL.md 完整内容被追加到消息流中
（不动 system prompt），辅助 agent 完成本阶段任务。
```

#### 3.2.4 projection.ts 的 CURRENT 段调整

`skill: xxx` 行保留（告诉 agent 用哪个 skill），但不再只放一个名字——改为**追加完整 skill 内容**作为 CURRENT 段的一部分，或作为 CURRENT 段之前的独立消息块。

**具体实现需在两处选择**：
- 选项 1：projection 的 CURRENT 段中，`skill:` 行改为 `skill (完整内容):` + 缩进全文
- 选项 2：在主循环中，进入节点时 `sendUserMessage(skillContent)` 作为独立消息，projection 中 `skill:` 仅保留名称

选项 2 更干净——技能内容是运行时追加的，不混入投影逻辑。推荐选项 2。

---

## 阶段 4：僵尸状态修复（重写 — 基于真实 pi API）

### 4.1 runAgent 监听 after_provider_response

`after_provider_response`（`types.d.ts:499`）携带 `status: number` 和 `headers: Record<string, string>`。DeepSeek 返回 400 时此事件以 `status: 400` 触发。

在 `PiNodeContext.runAgent` 中挂载此事件：

```typescript
const onProviderError = (event: AfterProviderResponseEvent) => {
  if (event.status >= 400 && this.activeRunId === runId && this.activeResolve) {
    this.activeResolve({
      nodeId: this.currentNodeId ?? "unknown",
      status: "failed",
      result: { reason: `Provider error: HTTP ${event.status}` },
    });
  }
};
pi.on("after_provider_response", onProviderError);
// promise settled 后 pi.off 解绑
```

**这替代了 v1 中所有"缩短超时 / 伪代码 turn_error / 60s"的错误方案。** 精确、无延迟、不靠超时兜底。

### 4.2 图终止信号回流到 agent

当 `executeGraph` 的 `catch` 块捕获异常时，在 reset runtime 之前，用 `sendUserMessage` 向 agent 注入可见的终止信号：

```typescript
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  debugLog.graphError(graph.id, reason);

  // 用 sendUserMessage（不是 sendMessage + 不存在的 role 字段）
  piInner.sendUserMessage(
    `[系统] 图 "${graph.id}" 因错误意外终止：${reason}。当前节点已失效，请停止推理。`,
  );

  piInner.sendMessage({
    customType: "loop_graph_error",
    content: `图运行错误: ${reason}`,
    display: true,
  });
}
```

**v1 的错误**：用了 `sendMessage({ role: "user", ... })` —— `sendMessage` 没有 `role` 字段（`types.d.ts:874`），只有 `customType/content/display/details`。给 agent 注入可见消息的正确 API 是 `sendUserMessage`。

### 4.3 agent_end 触达已死图时的防御

`onAgentEnd` 中检测 `activeRunId === 0`（图已终止，agent 仍在跑），此时用 `sendUserMessage` 告知 agent 停止：

```typescript
onAgentEnd(): void {
  if (this.activeRunId === 0) {
    this.pi.sendUserMessage(
      "[系统] 当前图已终止，你的后续操作不会被接收。",
    );
    return;
  }
  // ... 正常流程
}
```

---

## 执行顺序和依赖

```
阶段 1 ──► 阶段 2 ──► 阶段 4
  │
  └──► 阶段 3（可并行，但涉及决策需先拍板）
```

| 阶段 | 解决哪些问题 | 风险 | 关键 pi API |
|------|-------------|------|------------|
| 1 | 根因（问题 1/2/3） | 低 | `getActiveTools()` |
| 2 | 问题 4 + 存在性校验 | 低（时序在首次 execute） | `getAllTools()` |
| 3 | 问题 1 定论 + skill 决断 | 取决于拍板结果 | `before_provider_request`、`resources_discover`、`before_agent_start` |
| 4 | 问题 5 | 低（用真实事件） | `after_provider_response`、`sendUserMessage` |

---

## 已决策项

- **skill**：走方案 A — 接入 pi 原生 skill 系统（`resources_discover` 注册路径）。但不动 system prompt，skill 内容通过消息流追加。
- **system prompt**：写入宪法 — SDK 永远不修改 system prompt。上下文操作只在消息流追加侧进行。
