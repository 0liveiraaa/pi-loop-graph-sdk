# 核心 API 参考

本文列出 Loop Graph SDK 公共导出。所有类型签名最终来源为源码。

## 根入口（`pi-loop-graph-sdk`）

### 图构建

| 导出 | 说明 |
|------|------|
| `defineGraph(graph)` | 创建并校验、冻结图定义 |
| `defineSingleAgentGraph(input)` | 单节点图 Builder |
| `defineLinearGraph(input)` | 线性管道图 Builder |
| `agentNode(input)` | 创建 Agent 节点定义 |
| `codeNode(input)` | 创建 Code 节点定义 |
| `graphNode(input)` | 创建 Graph 节点定义 |
| `graphRef(id, version)` | 创建图引用 |
| `entry(id, config)` | 创建入口 |
| `connect(to, transition?)` | 创建连接 draft |
| `finish(transition?)` | 创建终点连接 draft |
| `firstMatch(connections)` | 创建 first-match 路由 |
| `defineTransition(transition)` | 创建可复用迁移策略 |
| `toolSet(...names)` | 创建工具集字面量 |
| `skillRef(name, version?, required?)` | 创建 Skill 引用 |

### Mechanism

| 导出 | 说明 |
|------|------|
| `defineMechanism(mechanism)` | 创建并冻结 Mechanism 定义 |

### Host 与执行

| 导出 | 说明 |
|------|------|
| `createGraphHost(options?)` | 创建 Graph Host |
| `executeIsolatedGraph(graph, options)` | 一次性隔离执行图 |
| `createLoopGraphExtension(pi, options?)` | 创建 Pi extension 实例 |
| `createPiGraphHost(options)` | 使用真实 Pi Session 创建隔离 Graph Host |

### 类型（值导出）

| 导出 | 说明 |
|------|------|
| `Type` | TypeBox，用于定义 JSON Schema |

### 类型（类型导出）

| 导出 | 说明 |
|------|------|
| `Graph` / `GraphDefinition` | 图定义类型 |
| `GraphRef` | 图引用 `{ id: string; version: string }` |
| `Entry` | 入口类型 |
| `Stage` | 阶段装配类型 |
| `NodeDefinition` / `AgentNodeDefinition` / `CodeNodeDefinition` / `GraphNodeDefinition` | 节点定义类型 |
| `Route` / `Connection` / `Transition` | 路由和迁移类型 |
| `ContextFrame` / `ContextContent` | 公共上下文类型 |
| `SkillRef` / `ToolSet` | Skill 和工具集类型 |
| `Mechanism` | Mechanism 类型 |
| `NodeCompletion` | 节点完成类型 |
| `GraphRunResult` / `GraphFailure` / `GraphFailureCode` | 图运行结果类型 |
| `GraphHost` / `GraphHostRunOptions` | Host 类型 |
| `LoopGraphExtension` / `LoopGraphExtensionOptions` / `LoopGraphLimits` | Extension 类型 |
| `JsonValue` / `JsonSchema` | JSON 兼容类型 |
| `InvocationLimits` | 调用限制类型 |
| `RecordingMode` / `ReplayReference` | 录制模式类型 |

## /replay 子路径（`pi-loop-graph-sdk/replay`）

| 导出 | 说明 |
|------|------|
| `parseReplay(input)` | 解析 replay JSON 为 ReplayModel |
| `exportReplayHtml(model)` | 生成自包含离线 HTML |
| `FileRunStore` | 默认文件存储实现 |
| `CHECKPOINT_SCHEMA_VERSION` / `encodeCheckpoint` / `decodeCheckpoint` | checkpoint codec |
| `Recorder` / `finalizeJournal` / `toRecordedJson` | 录制与终结 |
| **类型**：`ReplayModel`、`ReplayDocument`、`ReplayEvent`、`ReplayEventEnvelope`、`RunStore`、`CheckpointStore`、`CheckpointDocument`、`PricingResolver` 等 |

## /advanced 子路径（`pi-loop-graph-sdk/advanced`）

| 导出 | 说明 |
|------|------|
| `GraphRuntime` | 核心运行时 |
| `ContextState` / `materializeProjection` | 上下文状态与投影 |
| `validateGraph` / `assertValidGraph` / `validateGraphTools` | 图校验 |
| `ToolCatalog` | 工具目录（用于构造 `toolCatalog` 配置） |
| `SkillCatalog` | Skill 目录（用于构造 `skillCatalog` 配置） |
| `IsolatedSessionGraphHost` | 底层隔离 Host（高级接口） |
| **类型**：`GraphRuntimeHost`、`AgentExecutionContext`、`InvocationBoundary`、`ContextProjection`、`ContextContribution`、`ContextSnapshot`、`HostBaseline`、`UnsafeToolResolver`、`ToolImplementation`、`SkillResolver`、`GraphExecutionHost` 等 |

## /extension 子路径（`pi-loop-graph-sdk/extension`）

仅用于 pi 自动加载。不作为杂项公共入口。

## 已删除的 0.1 导出

以下 0.1 API 不在 0.2 公共面中：

- `createAgentExecute` — 使用 `agentNode` 代替
- `registerGraph` / `initRegistry` / `findEntry`（全局）— 使用 `createLoopGraphExtension` 的实例方法
- `Graph.routing`、Node 必填 `id`、`Edge.from`、`END` — 使用 stages + Connection + Transition + finish()
- `defaultTools`、`AgentRunRequest.tools`、`appendContext`、`NodeContext.callTool()` — 使用三层工具模型 + Context Projection
- `GraphRegistry`、`FRAMEWORK_TOOLS`、`resolveNodeTools`、`defaultToolResolver` — 使用 ToolCatalog

迁移指南见 [migration-0.1-to-0.2.md](../migration-0.1-to-0.2.md)。
