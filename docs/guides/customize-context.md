# 自定义上下文：frameFormatter、contextRenderer 与动态追加

## 适用场景

你需要控制 LLM 在节点进入时看到什么指引，以及已完成阶段的历史如何展示给后续节点。默认情况下 SDK 以 JSON 格式展示历史帧，并以 `=== CURRENT ===` 标签展示当前任务——你可以完全替换这些展示方式。

## 最小代码

### 1. frameFormatter：自定义历史摘要格式

历史摘要来自已经保存的工作记忆。每条记忆的结构由你的业务定义；下面假设它们含有 `stage` 和 `payload`：

```typescript
const loop = createLoopGraphExtension(pi, {
  frameFormatter: (frames) => {
    return frames
      .map((f) => {
        const memory = f as { stage?: string; payload?: Record<string, unknown> };
        const kv = Object.entries(memory.payload ?? {})
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        return `[${memory.stage ?? "未命名阶段"}]\n${kv}`;
      })
      .join("\n\n");
  },
});
```

LLM 看到的效果：

```text
[select_target]
  subject: 数学
  mode: 出题

[generate_question]
  question_text: 二叉树的前序遍历是什么？
  difficulty: easy
```

返回 `null` 则跳过全部历史摘要，LLM 只看到当前节点上下文。

### 2. contextRenderer：自定义当前节点指引

`contextRenderer` 控制节点进入时 SDK 追加给 LLM 的消息内容：

```typescript
const loop = createLoopGraphExtension(pi, {
  contextRenderer(input) {
    return {
      anchor: {
        kind: "current",
        content: `当前任务：\n${input.node.subGoal}\n\n完成后请提交结构化结果。`,
      },
    };
  },
});
```

`contextRenderer` 接收只读快照，返回 `null` 或 `anchor: null` 表示不展示节点指引，但 SDK 内部仍需保留必要标记以正确恢复上下文。

可读取的信息：
- 当前图、当前节点和一次性入参
- 节点进入时的历史摘要快照
- agent-choice 的可选边
- 已加载的 skill 正文

### 3. 按图/节点覆盖渲染器

不同图或节点可能需要不同的展示方式：

```typescript
const loop = createLoopGraphExtension(pi, {
  contextRenderer: renderDefault, // 全局默认
  contextRenderers: {
    graphs: {
      contract_review: renderContractGraph,
    },
    nodes: {
      contract_review: {
        final_check: renderFinalCheckNode,
      },
    },
  },
});
```

覆盖优先级（从高到低）：
1. 本次 `executeGraph()` 调用传入的 renderer
2. 当前 Node 级 renderer
3. 当前 Graph 级 renderer
4. Extension 默认 renderer
5. SDK 兼容 renderer

### 4. 自定义 skill 展示

默认情况下，节点关联的 skill 以 `skill: {名称}` 和 `[skill: name]` 格式包裹正文展示。你可以自定义：

```typescript
const loop = createLoopGraphExtension(pi, {
  skillRenderer(ref, content) {
    return {
      kind: "skill",
      content: `参考规则（${ref}）：\n${content}`,
    };
  },
});
```

返回 `null` 则完全隐藏 skill 正文和名称。

### 5. 机制层动态追加内容

在节点执行过程中，机制可以动态向 LLM 上下文追加文本或图片：

```typescript
const progressNotifier: Mechanism = {
  name: "progress",
  onNodeEnter(ctx) {
    ctx.context.append("计时与监控已启动");
  },
  onToolResult(ctx) {
    ctx.context.append(`工具 ${ctx.event.toolName} 已完成`);
  },
};
```

支持的内容类型：

```typescript
ctx.context.append([
  { type: "text", text: "请参考下面的截图" },
  { type: "image", data: base64Data, mimeType: "image/png" },
]);
```

机制只能提供内容块；消息的类型、展示方式和触发行为由 SDK 固定。在当前节点执行周期（scope）结束后，`append` 返回 `false`，内容不会泄漏到后续节点。

## 运行顺序

1. 节点进入 → 如果当前节点有关联 skill，先加载 skill 正文。
2. 调用 `contextRenderer` 生成当前节点指引。
3. 调用 `skillRenderer`（如有）展示 skill 内容。
4. SDK 将历史摘要（由 `frameFormatter` 生成）与当前指引一起追加到对话流。
5. 节点运行期间，机制层的 `ctx.context.append()` 动态追加内容。
6. 上下文压缩后，SDK 不会重新调用 renderer，而是复用首次生成的结果。

## 安全边界与常见错误

- **renderer 是同步函数，不要在其中做异步 I/O**：Skill 加载是异步的，通过 `skillProvider` 处理。contextRenderer 只做格式化。
- **不要依赖 renderer 的副作用**：renderer 可能被缓存，内部修改不会影响运行时。
- **`ctx.context.append()` 在当前节点执行周期结束后自动失效**：不要在 scope 之外缓存 `ctx.context` 引用。
- **不要使用固定 frame 结构的兼容字段作为最佳实践**：`frame` 是开发者定义的业务记忆，兼容字段（`nodeId`、`status` 等）不是必须的 schema。你的 `frameFormatter` 应适配你自己定义的 frame 结构。

## 相关概念

- [上下文与状态](../concepts/glossary.md)
- [机制 Hooks](mechanism-hooks.md) — `ctx.context.append()` 的完整生命周期
- [子图调用](call-subgraphs.md) — renderer 在子图中的传播规则
