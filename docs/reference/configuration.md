# 配置项参考

本文列出 `createLoopGraphExtension(pi, options?)` 中 `LoopGraphExtensionOptions` 的全部字段，以及相关子配置类型。

---

## LoopGraphExtensionOptions

```typescript
interface LoopGraphExtensionOptions {
  demoGraphs?: boolean;
  runtimeOnly?: boolean;
  defaultTools?: string[];
  skillBasePath?: string;
  frameFormatter?: (frames: ContextFrame[]) => string | null;
  contextRenderer?: NodeContextRenderer;
  contextRenderers?: ContextRendererRegistry;
  modelMessageFormatter?: Partial<ModelMessageFormatter>;
  completionToolResultFormatter?: CompletionToolResultFormatter;
  skillProvider?: SkillContentProvider;
  skillRenderer?: SkillContentRenderer;
  skillFailure?: SkillFailurePolicies;
  createDelegateHost?: DelegateHostFactory;
  delegateTools?: ToolDefinition[];
  delegateCompaction?: CompactionSettings;
  toolResultMaxBytes?: number;
  formatToolResult?: GraphToolResultFormatter;
  toolResolver?: ToolResolver;
  traceSink?: LoopGraphTraceSink;
  logger?: LoopGraphLogger;
  debug?: boolean;
  debugLogPath?: string;
  limits?: LoopGraphLimits;
  mechanismRuntime?: MechanismRuntimeOptions;
}
```

### 图注册与运行模式

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `demoGraphs` | `boolean` | `false` | 是否注册 SDK 自带测试图（`/echo-test` 等）。仅 debug/demo extension 入口应设为 `true`。 |
| `runtimeOnly` | `boolean` | `false` | 仅安装执行 Runtime，不注册 session UI 通知和对外 invocation。供独立子 AgentSession 使用。 |

### 工具配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `defaultTools` | `string[]` | `[]` | 所有节点默认可用的工具名称列表。为空时只保留 `read` + `__graph_complete__`。 |
| `toolResolver` | `ToolResolver` | — | 按 `graphId`/`nodeId` 动态解析工具集。返回值统一去重，`read` 与 `__graph_complete__` 由 SDK 强制保留。 |
| `toolResultMaxBytes` | `number` | — | graph tool 返回给模型的最大 UTF-8 字节数。 |
| `formatToolResult` | `GraphToolResultFormatter` | — | graph tool 的全局模型可见文本 formatter。单个 invocation 的 formatter 优先。 |

### Skill 配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `skillBasePath` | `string` | `process.cwd() + "/skills"` | skill 文件的根路径。`node.skill` 的 `SKILL.md` 在此路径下按 `{name}/SKILL.md` 查找。 |
| `skillProvider` | `SkillContentProvider` | 文件读取 | 异步解析 skill 引用的函数。可从数据库或远程服务加载。 |
| `skillRenderer` | `SkillContentRenderer` | 默认包裹 | 控制 skill 正文如何展示给 LLM。返回 `null` 隐藏正文和名称。 |
| `skillFailure` | `SkillFailurePolicies` | `{ missing: "ignore", error: "ignore" }` | skill 缺失或加载出错时的策略。`"fail"` 终止当前图。 |

### 上下文渲染

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `frameFormatter` | `(frames: ContextFrame[]) => string \| null` | 默认 JSON | 自定义已完成历史帧在 LLM 上下文中的展示格式。返回 `null` 跳过历史段。 |
| `contextRenderer` | `NodeContextRenderer` | 默认 CURRENT 格式 | 全局默认的节点进入时上下文渲染器。 |
| `contextRenderers` | `ContextRendererRegistry` | — | 按 `graphId`/`nodeId` 覆盖的渲染器注册表。Node 级覆盖 Graph 级。 |

覆盖优先级（从高到低）：

```text
本次 executeGraph 调用 → 当前 Node → 当前 Graph → Extension 默认 → SDK 兼容 renderer
```

`contextRenderer` 接收只读快照，返回 `null` 表示不展示指引。渲染器是同步函数，每次节点进入只调用一次。

### 模型消息自定义

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modelMessageFormatter` | `Partial<ModelMessageFormatter>` | 自定义验证驳回、节点未完成、dead-run、图失败时的文案。 |
| `completionToolResultFormatter` | `CompletionToolResultFormatter` | 自定义 `__graph_complete__` 返回给模型的文本格式。 |

只改变 LLM 看到的文字，不影响 `__graph_complete__` 的名称、状态或 Runtime 退出规则。

### Delegate 配置

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `createDelegateHost` | `DelegateHostFactory` | 为 `boundary: "delegate"` 创建独立 Session host 的工厂。未配置时 delegate 会抛出明确错误。 |
| `delegateTools` | `ToolDefinition[]` | 传递给递归隔离子会话的真实工具定义列表。 |
| `delegateCompaction` | `CompactionSettings` | 隔离子会话的上下文压缩配置，由 host factory 消费。 |

### 可观测性

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `traceSink` | `LoopGraphTraceSink` | — | 结构化生命周期事件收集器。异常不会影响图执行。 |
| `logger` | `LoopGraphLogger` | — | 通用日志输出接口。`graph_error` 用 `error()`，其余用 `debug()`。 |
| `debug` | `boolean` | `false` | 是否启用默认 JSONL 生命周期日志。 |
| `debugLogPath` | `string` | `"loop-graph-debug.log"` | JSONL 日志文件路径。 |

---

## LoopGraphLimits

```typescript
interface LoopGraphLimits {
  rootMaxSteps?: number;        // 顶层 root 图最大节点步数。默认 100。
  childMaxSteps?: number;       // call/compose 子图最大步数。默认 50。
  agentRunTimeoutMs?: number;   // 单次 runAgent 超时毫秒数。默认 300000（5 分钟）。
  completionValidationTimeoutMs?: number;  // 单次验证门超时毫秒数。默认 60000。
}
```

所有限制值必须是有限正整数，非法值在 `createLoopGraphExtension()` 时报错。`completionValidationTimeoutMs` 同时用于机制层 `validateCompletion` 的超时控制。

---

## MechanismRuntimeOptions

```typescript
interface MechanismRuntimeOptions {
  execRoot?: string;                // ctx.exec.run 的受控根目录
  execTimeoutMs?: number;           // 默认命令超时毫秒数
  execMaxOutputBytes?: number;      // stdout/stderr 最大字节数
  allowExecOutsideRoot?: boolean;   // 是否允许逃出 execRoot
  eventMaxBytes?: number;           // 事件内容最大字节数
  completionValidationTimeoutMs?: number;  // 验证门超时
}
```

机制通过 `ctx.exec.run(command, args, options?)` 执行外部命令时自动绑定这些策略。

---

## 运行限制

| 限制项 | 默认值 | 触发时行为 |
| --- | --- | --- |
| 同一实例并发执行 | 不支持 | 第二个调用立即抛错 |
| 无匹配入口 | — | 顶层图返回 `failed`；子图 throw |
| 无匹配边 | — | 图以当前节点状态结束；Runtime 目前会写入一条兼容说明帧，不应依赖其固定结构 |
| 超过最大步数 | root: 100 / child: 50 | 图返回 `failed`，`result.reason` 包含 "Max steps exceeded" |
| runAgent 超时 | 300 秒 | Agent 返回 `failed` 状态，原因说明超时 |
| 验证门超时 | 60 秒 | 超时错误，受 failurePolicy 控制 |

---

## 相关链接

- [核心类型与工厂 API](api.md)
- [生命周期](lifecycle.md)
- [错误与限制](errors-and-limits.md)
