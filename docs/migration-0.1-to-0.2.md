# 从 0.1 迁移到 0.2

0.2 是一次允许破坏性变更的重整。本文逐项列出变更和迁移方式。0.2 不保留 0.1 兼容层。

## 图结构

| 0.1 | 0.2 |
|-----|-----|
| `Graph.nodes: Record<string, Node>` + `Graph.routing: Record<string, NodeRouting>` | `Graph.stages: Record<StageId, Stage>` |
| `Node.id`（必填，与 routing key 重复） | Node 无 `id`，Stage ID 是唯一身份 |
| `Edge.from` / `Edge.to` / `END` | `Connection.to` / `finish()` |
| `Edge.migrate(instance, completion)` | `Transition`（guard、frame、map、output 分离） |
| `END` symbol | `finish({ output: ... })` |
| `Entry.startNodeId` | `Entry.to` |
| `Graph.invocation`（命令/tool 暴露配置嵌入图） | `registerGraph` + `exposeGraph` 分离 |

## 节点

| 0.1 | 0.2 |
|-----|-----|
| `{ kind: "code", execute, ... }` + `createAgentExecute()` | `agentNode({...})`  或 `codeNode({ execute })` |
| `kind: "graph"` + `graph: Graph` | `graphNode({ graph: graphRef(...), boundary })` |
| `Node.tools: string[]` | AgentNode/CodeNode `tools: string[] \| "all"` |
| `Node.skill: string` | `Node.skills: [skillRef(name, version)]` |

## 上下文

| 0.1 | 0.2 |
|-----|-----|
| `background` 同时承载代码数据和模型上下文 | `Graph.input`（数据契约）+ `context.background.select/render`（模型投影） |
| `createLoopGraphExtension({ frameFormatter, contextRenderer, contextRenderers })` 全局配置 | `Graph.context.background/memory` 和 `Node.context.focus` 的 `{ select, render }` |
| `instance.scratch` | Mechanism `createState()` |
| `ctx.context.append(content)` | `ctx.context.add(key, content, { lifetime, retention })` |

## 工具

| 0.1 | 0.2 |
|-----|-----|
| `defaultTools` + `Node.tools` + `toolResolver` + `delegateTools` + `FRAMEWORK_TOOLS` | Host Tool Catalog → Graph Tool Policy → Node Tool Set → Protocol Tools |
| `createLoopGraphExtension({ defaultTools, toolResolver })` | `createLoopGraphExtension({ toolCatalog })` |
| `read` 是框架工具 | `read` 是业务工具，需 Graph 声明 + Node 选择 |

## 执行与结果

| 0.1 | 0.2 |
|-----|-----|
| `GraphRunResult.status: "ok" \| "failed" \| "cancelled"` + `result` 字段 | 判别联合 `completed \| failed \| cancelled`；成功用 `output`，失败用 `failure` |
| 字符串 reason | 结构化 `GraphFailure { code, phase, message, retryable, stageId }` |
| `loop.registerGraph(graph)`（含 invocation） | `loop.registerGraph(graph)` + `loop.exposeGraph(ref, exposure)` |
| `executeGraph(graph, trigger)` | `host.execute(graph, input)` |
| `IsolatedSessionGraphHost` | `createGraphHost()`；Pi Adapter 的内部 Host 工厂不属于公共导出 |
| 同 Session 内的调用栈 | Root 共享 budget + invocation-scoped child Session |

## 机制

| 0.1 | 0.2 |
|-----|-----|
| Mechanism 绑定 AgentInstance | 三层安装（Host → Graph → Node），state 生命周期由安装位置决定 |
| `onTurnStart/End`、`onToolStart/Result`、`beforeToolCall/afterToolResult` | 已删除。Agent 运行事件通过 recording/replay 记录 |
| `ctx.instance.scratch` | `ctx.state`（来自 `createState()`） |
| `ctx.events` | 已删除。公共审计入口改为 recording/replay |

## 回放

| 0.1 | 0.2 |
|-----|-----|
| `createJsonlTraceSink`、JSONL debug 日志 | `createGraphHost({ recording: "replay" })` + `RunStore` + Replay Model + HTML |
| `LoopGraphLifecycleEvent` 联合 | `ReplayEvent` + `ReplayEventEnvelope` |

## 全局 API

| 删除项 | 替代 |
|--------|------|
| `registerGraph(graph)` 全局函数 | `createLoopGraphExtension(pi).registerGraph(graph)` |
| `initRegistry()`、`findEntry()` | Graph Catalog（通过 Host 注入） |
| `createAgentExecute()` | `agentNode({ prompt, ... })` |
| `NodeContext.callTool()` | Code Node 通过闭包/业务服务访问，Agent 通过工具声明使用 |

## 相关文档

- [十分钟快速开始](getting-started.md) — 0.2 教程
- [图模型](concepts/graph-model.md) — stages、Connection、Transition
- [API 参考](reference/api.md) — 完整导出
