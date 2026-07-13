# 为节点增加监听、验证与自动清理

## 适用场景

你需要在节点执行过程中插入横切逻辑：事件监听、工具审计、进度上报、外部命令执行、私有状态追踪，以及这些逻辑在异常时的安全收尾。

## 最小代码

### 1. 节点结束时自动清理

每个机制在每次节点进入时获得一个独立的当前节点执行周期（scope）。它提供取消信号、活跃检查和清理注册：

```typescript
import type { Mechanism } from "pi-loop-graph-sdk";

const timingMechanism: Mechanism = {
  name: "timing",
  onNodeEnter(ctx) {
    // 记录开始时间
    ctx.instance.scratch[`${ctx.node.id}_started`] = Date.now();

    // 注册定时采样
    const timer = setInterval(() => collectSample(), 1000);
    ctx.scope.onCleanup(() => clearInterval(timer));

    // 监听 scope 取消信号
    ctx.scope.signal.addEventListener("abort", () => cancelBackgroundWork(), {
      once: true,
    });
  },
};
```

scope 与节点同生共死。节点正常完成或抛错时，Runtime 总会关闭 scope 并按逆序执行 cleanup。

### 2. 保存机制自己的计数

同一节点可能因循环而多次进入。机制可以在这些执行之间保留自己的私有状态：

```typescript
const retryTracker: Mechanism<{ count: number }> = {
  name: "retry-tracker",
  createState: () => ({ count: 0 }),
  onNodeExit(ctx) {
    if (ctx.completion.status === "failed") {
      ctx.state.count += 1;
    }
  },
  onNodeEnter(ctx) {
    if (ctx.state.count > 0) {
      ctx.context.append(`当前节点已重试 ${ctx.state.count} 次`);
    }
  },
};
```

state 按工作区 + 机制对象身份隔离：call 创建新状态，compose 复用父级状态。state 不进入 LLM 上下文，仅代码侧可见。

### 3. 监听当前节点的事件

在 scope 内订阅工具结果和 turn 事件，scope 关闭时自动取消：

```typescript
const toolObserver: Mechanism = {
  name: "tool-observer",
  onNodeEnter(ctx) {
    ctx.events.onToolResult((event) => {
      ctx.context.append(`工具 ${event.toolName} 完成`);
    });
    // scope 关闭时自动 dispose 全部订阅，无需手动清理
  },
};
```

可用事件：`onToolResult`、`onTurnStart`、`onTurnEnd`。

### 4. 执行有时间限制的命令

在 scope 内执行外部命令，自动绑定超时和取消信号：

```typescript
const buildChecker: Mechanism = {
  name: "build-checker",
  failurePolicy: "fail-graph",
  async validateCompletion(ctx) {
    const result = await ctx.exec.run("npm", ["run", "build"], {
      timeoutMs: 120_000,
    });
    if (result.code !== 0) {
      return { action: "reject", reason: result.stderr || "构建失败" };
    }
    return {
      action: "allow",
      verifiedResult: { buildTime: Date.now() },
    };
  },
};
```

`ctx.exec.run` 自动接收 scope 的取消信号。输出超过预算时返回截断文本及截断标记。

### 5. 完整生命周期示例

```typescript
const auditMechanism: Mechanism = {
  name: "full-audit",
  failurePolicy: "continue",

  onNodeEnter(ctx) {
    ctx.context.append("审计：开始监控");
  },

  onToolStart(ctx) {
    ctx.context.append(`审计：LLM 调用 ${ctx.event.toolName}`);
  },

  onTurnEnd(ctx) {
    ctx.context.append(`审计：一轮对话结束`);
  },

  onNodeExit(ctx) {
    ctx.context.append(
      `审计：节点完成，状态为 ${ctx.completion.status}`
    );
  },

  onNodeError(ctx) {
    // 只观察，不能替换原始错误
    logError(ctx.node.id, ctx.error);
  },
};
```

## Hook 执行顺序

```text
onNodeEnter（串行）
  → beforeAgentRun
  → [onTurnStart → onToolStart → beforeToolCall → 工具执行 → afterToolResult/onToolResult → onTurnEnd] × N
  → validateCompletion × N
→ onNodeExit（边选择之前）
→ scope 关闭（逆序 cleanup + 取消事件订阅）

异常时：
→ onNodeError（观察原始错误，不能替换）
→ scope 关闭
```

## 失败策略

| `failurePolicy` | Hook 抛错后的行为 |
| --- | --- |
| `continue`（默认） | 记录日志并继续 |
| `fail-node` | 框架生成可信失败完成信号，跳过节点主体，交给路由 |
| `fail-graph` | 终止当前图，仍执行 onNodeError 和全部 cleanup |

同一阶段多个机制发生控制性失败时，全部 Hook 仍按顺序执行，最终优先级为 `fail-graph > fail-node > continue`。

## 两层能力面

| 通道 | 框架保证 |
| --- | --- |
| `ctx.scope` | 与当前节点执行周期同生共死；提供取消信号、活跃检查、清理注册 |
| `ctx.events` | scope 关闭时自动取消订阅；handler 失败受 failurePolicy 保护 |
| `ctx.state` | 按工作区 + 机制身份隔离；不入 LLM 上下文 |
| `ctx.exec.run()` | 自动绑定 scope 取消信号和时间限制 |
| `ctx.context.append()` | scope 关闭后返回 false，不会污染后续节点 |
| `ctx.pi` | 完整但非托管能力；副作用不自动获得清理保证 |

## 安全边界与常见错误

- **优先使用 `ctx.events` 而非 `ctx.pi.on()`**：`pi.on()` 返回 `void`，监听器残留到 Session 结束。`ctx.events` 在 scope 关闭时自动取消。
- **cleanup 抛错不阻止其他 cleanup**：也无法覆盖原始错误。不要在一个 cleanup 中依赖另一个 cleanup 必须成功。
- **`onNodeError` 只能观察，不能替换错误**：原始错误会继续传播到图级错误处理。
- **state 不是跨节点业务状态通道**：state 是机制内部私有状态，不同机制之间互相隔离。
- **验证型机制的 `failurePolicy` 应设为 `fail-graph` 或 `fail-node`**：默认为 `continue` 会静默放行验证异常。

## 相关概念

- [机制模型](../../设计/CONTEXT.md)
- [工具控制](control-tools.md) — beforeToolCall/afterToolResult 的门禁用法
- [自动验证](automatic-validation.md) — validateCompletion 的完整用法
- [自定义上下文](customize-context.md) — ctx.context.append 的展示效果
