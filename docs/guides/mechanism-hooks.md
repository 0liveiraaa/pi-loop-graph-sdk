# Mechanism 生命周期与清理

## 适用场景

你需要在节点执行过程中插入横切逻辑：计时、审计、资源清理、上下文追加。

概念和 Hook 清单见[Mechanism](../concepts/mechanisms.md)。本文聚焦实操。

## 清理：scope.onCleanup

每个 Mechanism 在 scope（Host/Graph/Node）中安装时获得独立的生命周期管理。scope 退出时自动按注册逆序（LIFO）执行清理：

```typescript
const timingMechanism = defineMechanism({
  name: "timing",
  onNodeEnter(ctx) {
    const start = Date.now();

    // 注册清理：节点退出时自动执行
    ctx.scope.onCleanup(() => {
      console.log(`Node took ${Date.now() - start}ms`);
    });
  },
});
```

scope 取消信号通过 `ctx.scope.signal`（AbortSignal）可监听。

## 上下文追加

`ctx.context.add` 向模型上下文追加内容：

```typescript
onNodeEnter(ctx) {
  const handle = ctx.context.add("security-notice", "请勿在回答中泄露用户信息", {
    lifetime: "node-visit",     // 该节点访问内有效
    retention: "sticky",        // 每次 LLM call 重投影
  });

  // handle.update("新内容");   // 更新
  // handle.dispose();           // 手动删除（scope 退出时自动）
}
```

retention 选项：
- `sticky`：每次 LLM call 重投影，不依赖压缩摘要
- `foldable`：允许被压缩为摘要
- `transient`：下一次 LLM call 后自动删除

不能创建比安装 scope 更长的 lifetime。

## 外部命令：ctx.exec.run

```typescript
onNodeEnter(ctx) {
  const result = await ctx.exec.run("python", ["validate.py"], {
    cwd: "./scripts",
    timeoutMs: 5000,
  });
  if (result.exitCode !== 0) {
    // 处理失败
  }
}
```

`exec.run` 受 execRoot、超时和输出字节预算约束。

## agent-choice 与 validateCompletion 交互

当 Route 使用 agent-choice 时，模型的 completion 必须包含 `chosen_edge_id` 字段。验证顺序是 Node validator → Route structure → Mechanism `validateCompletion` → agent-choice：

```typescript
validateCompletion(ctx) {
  // ctx.completion 是业务 result，可直接检查
  if (!ctx.completion || typeof ctx.completion !== "object") {
    return { action: "reject", reason: "completion 必须是对象" };
  }
  return { action: "allow" };
}
```

## 相关文档

- [Mechanism](../concepts/mechanisms.md) — 概念和 Hook 清单
- [内部：Mechanism Runtime](../internals/mechanism-runtime.md) — 实现协议
- [自定义上下文](customize-context.md) — select/render 投影
