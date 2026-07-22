# 配置项参考

## createGraphHost(options?)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `runtime` | `GraphRuntimeHost` | — | 底层 Runtime 配置（图解析、tools、skills、mechanisms 等） |
| `recording` | `RecordingMode` | `"replay"` | 录制模式 |
| `recordingRequired` | `boolean` | `false` | 录制失败是否升级为图失败 |
| `runStore` | `RunStore` | `FileRunStore(".loop-graph/runs")` | 运行记录存储 |
| `checkpointStore` | `CheckpointStore` | 同 runStore | checkpoint 存储 |
| `artifactThresholdBytes` | `number` | 65536 | 超过此字节数的大载荷存储为 artifact 引用 |
| `pricingResolver` | `PricingResolver` | — | 费用计算函数 |
| `dispose` | `() => void \| Promise<void>` | — | Host 释放时的额外清理 |
| `limits` | `InvocationLimits` | SDK 默认上限 | Host 硬上限；单次运行只能收紧，不能扩大 |

## GraphRuntimeHost（runtime 字段）

| 字段 | 说明 |
|------|------|
| `resolveGraph` | `(ref) => Graph | undefined`，用于解析 GraphRef；GraphCatalog 不属于公共导出 |
| `toolCatalog` | 工具实现注册中心 |
| `skillCatalog` | Skill 解析中心 |
| `baseline` | Host baseline：`{ kind: "isolated" }`（默认）、`{ kind: "inherit" }`、`{ kind: "custom", ... }` |
| `mechanisms` | Host 级 Mechanism 列表 |
| `maxStickyContextBytes` | sticky 上下文最大字节数（默认 256KB） |
| `checkpointStore` | checkpoint 存储（用于 Phase 10 恢复） |
| `runAgent` | Agent Node 的执行实现（Pi adapter 提供） |
| `createInvocationAgentHost` | call/compose 子 Session 创建 |

## createLoopGraphExtension(pi, options?)

| 字段 | 类型 | 说明 |
|------|------|------|
| `toolCatalog` | `ToolCatalog`（来自 `/advanced`） | 业务工具注册 |
| `skillCatalog` | `SkillCatalog`（来自 `/advanced`） | Skill 注册和解析 |
| `baseline` | `HostBaseline` | Host baseline |
| `limits` | `LoopGraphLimits` | 扩展级运行限制 |
| `recording` | `RecordingMode` | 录制模式 |
| `recordingRequired` | `boolean` | 录制失败是否升级为图失败 |
| `runStore` | `RunStore`（来自 `/replay`） | 运行记录存储 |
| `mechanisms` | `Mechanism[]` | Host 级 Mechanism |
| `outputContractMaxBytes` | `number` | Output Contract 最大字节数 |
| `contextMaxBytes` | `number` | sticky 上下文最大字节数 |
| `artifactThresholdBytes` | `number` | 大载荷 artifact 阈值 |
| `pricingResolver` | `PricingResolver`（来自 `/replay`） | 费用计算 |
| `unsafeToolResolver` | `UnsafeToolResolver`（来自 `/advanced`） | 越权工具解析 |
| `runtimeOnly` | `boolean` | 仅安装 Runtime，不注册 UI 通知 |

`exposeGraph()` 的 command/tool exposure 默认使用 `execution: "isolated"`，为每次调用创建独立 Pi Session。只有明确接受当前会话历史和状态相互影响时，才使用 `execution: "current-session"`。

## LoopGraphLimits

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `rootMaxSteps` | 100 | root 图最大节点步数 |
| `childMaxSteps` | 50 | call/compose 子图最大步数 |
| `agentRunTimeoutMs` | 300000 | 单次 Agent Run 超时（毫秒） |
| `completionValidationTimeoutMs` | 60000 | 验证门超时（毫秒） |

## InvocationLimits（Runtime 内部）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `maxGraphDepth` | 8 | 最大图嵌套深度 |
| `maxGraphInvocations` | 64 | 最大图调用总数 |
| `maxTotalNodeVisits` | 500 | 最大节点访问总数 |

`InvocationLimits` 通过 `host.execute(graph, input, { limits })` 传入。Host 可收紧不可扩大。

## Recording 模式

| 模式 | 说明 |
|------|------|
| `"off"` | 不记录 |
| `"events"` | 仅生命周期事件 |
| `"replay"`（默认） | 完整人类可读记录，脱敏 |
| `"forensic"` | 原始载荷，含敏感数据 |

## 相关文档

- [API 参考](api.md) — 完整导出清单
- [错误与限制](errors-and-limits.md) — failurePolicy、超时、步数
- [生命周期](lifecycle.md) — 执行顺序
