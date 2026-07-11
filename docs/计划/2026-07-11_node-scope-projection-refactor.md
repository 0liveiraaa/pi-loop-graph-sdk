# 节点作用域投影重构计划

> 2026-07-11 | 优先级：高
>
> 建议在 session 续跑、帧持久化和多 agent 工作开始前完成。

---

## 一、目标

把「随机隐藏哨兵 + transcript 下标切分」改成「语义化节点作用域 + compaction 协同投影」。

同时把所有图调用统一为**函数式上下文边界**：无论图由 pi agent 作为工具调用，还是由父图作为子图调用，被调用图都创建独立 `AgentInstance`，只通过显式 `input/background` 接收调用方提供的数据；调用方原始 transcript、frames 和 live ReAct 对被调用图不可见。图结束后，调用方只接收图的最终结构化结果，不能看到图内节点历史、工具轨迹或中间 ReAct。

本计划中的规范术语为**图调用边界（Graph Call Boundary）**。它描述调用方与被调用图之间的双向隔离契约，不等同于 NodeScope：

- `GraphCallScope` 管理「调用方 ↔ 整张图」的边界。
- `NodeScope` 管理「图内前序节点 ↔ 当前节点」的边界。
- `ContextFrame` 管理图内已完成节点的确定性业务记忆。

### 保持不变

| 不变项 | 说明 |
|--------|------|
| `AgentInstance.frames` | 帧栈结构不变 |
| `ContextFrame` | 不变 |
| `Edge.migrate` | 不变 |
| 子图隔离栈 | 不变 |
| `frameFormatter` | 签名和用法不变 |
| COMPLETED / CURRENT 对外格式 | 对外不变 |
| 「框架不调用 LLM 摘要」原则 | 不变 |
| 显式数据通道 | 调用输入只走 `input/background`，调用输出只走图最终结果 |

### 不建议用 pi compaction 直接实现节点折叠

compaction 是会话级、阈值触发、LLM 生成且允许切开超长 turn；它和确定性的节点归约不是同一层机制。

---

## 二、当前哨兵实现的四个结构性问题

当前实现依赖三个条件：

1. 进入节点时注入随机字符串哨兵：[loop-graph-extension.ts](/src/adapter/loop-graph-extension.ts:259)
2. Runtime 保存这个字符串：[runtime.ts](/src/runtime.ts:61)
3. `context` 钩子在完整消息数组中搜索它：[projection.ts](/src/adapter/projection.ts:37)

80 条测试全部通过，但存在以下风险。

### 2.1 compaction 会删除哨兵

pi compaction 会重建上下文为：

```
compactionSummary + firstKeptEntryId 之后的消息
```

超长节点发生 split-turn compaction 时，当前节点哨兵完全可能落在切点之前。

更危险的是当前降级逻辑：

```typescript
currentIdx < 0 → messages 全部作为 head 保留
```

哨兵丢失后，旧 ReAct、compaction summary 等内容可能重新进入模型上下文，而不是继续保持节点隔离。

### 2.2 compaction 会总结原始 transcript

pi 的 compaction 基于 session 原始消息，而不是 SDK 的投影结果。因此它可能总结：

- 前序节点原始 ReAct
- 隐藏 skill 内容
- mechanism 消息
- 隐藏边界消息

生成的 `compactionSummary` 又会出现在投影的 `head` 中。这会形成第二套、由 LLM 生成的历史记忆，与确定性的 `frames` 并存，削弱「Edge 决定记住什么」的契约。

pi 的具体行为见 [compaction.md](../../node_modules/@earendil-works/pi-coding-agent/docs/compaction.md)。

### 2.3 当前 `head` 边界不是真正的图调用边界

`firstIdx = messages.findIndex(isBoundary)` 找的是整个 session 中第一个哨兵，不是当前 graph run 的入口。

同一 session 执行第二张图、循环进入、嵌套子图、compaction 重建后，`head` 的语义会逐渐模糊。

### 2.4 文档已经出现矛盾

- [entry-message-format.md](../../docs/设计/entry-message-format.md:72) 写的是 compaction 后「不重建 COMPLETED」，但现实现每次 `context` 都会根据 `frames` 重建。
- [implementation-status.md](../../docs/形态/implementation-status.md:320) 称「投影天然免疫」，实际上缺少 compaction 后哨兵丢失的验证。

---

## 三、目标架构

核心是去掉「纯边界哨兵」，换成有业务含义的节点作用域消息。

```
Graph frames（确定性业务记忆）
            │
            ▼
Context projector
            │
    ┌───────┴────────┐
    │                │
COMPLETED       当前 NodeScope 之后
frames 格式化    skill / mechanism /
                 prompt / live ReAct
```

### 3.1 NodeScope 消息

每次进入需要调用 agent 的节点时，追加一条语义消息：

```typescript
{
  customType: "loop_graph_node_scope",
  content: `
=== CURRENT ===
nodeId: grade
subGoal: 判断答案
completeWith: __graph_complete__({ status, result })
=== END ===
`,
  display: false,
  details: {
    protocol: 2,
    graphRunId,
    instanceId,
    scopeId,
    graphId,
    nodeId,
    visit,
    depth
  }
}
```

关键区别：

- `content` 是 agent 真正需要的 CURRENT 信息，不再是无意义随机串。
- `details` 不发送给 LLM，用于投影层可靠匹配。
- `scopeId` 比较结构化 metadata，不比较消息正文。
- CURRENT 不再由投影凭空重复合成。
- skill、mechanism、prompt、ReAct 全部位于该作用域消息之后。

> 当前 pi 公开 API 没有提供一个可跨 compaction 保持稳定的消息 entry ID，因此「完全零锚点、只记数组下标」的方案不可靠，不建议采用。

### 3.2 compaction 的正确定位

compaction 只承担 session 级 token 控制，不参与节点完成归约。

需要增加两个协同规则：

#### `session_compact`

当图正在运行且 compaction 完成后：

1. 保留现有 `frames`
2. 重新追加当前 `NodeScope` checkpoint
3. 使用同一个 `scopeId` 或明确的 `scopeGeneration + 1`
4. overflow retry 前让下一次 `context` 能重新找到当前作用域

pi 0.80.3 已正式提供：

- `session_before_compact`
- `session_compact`
- `reason`
- `willRetry`

#### context 投影

运行图时只输出：

```
格式化后的 frames
+ 当前匹配 NodeScope 开始的消息
```

不再自动保留整个 `head`，也不再让当前 graph run 期间生成的 `compactionSummary` 混入图上下文。

图结束后，SDK 停止活动节点投影，但调用级清洗仍可继续工作；pi 原始 session 和 compaction summary 仍然保留用于 UI、审计和普通对话续接，不等于全部重新暴露给调用方模型。

### 3.3 图调用边界：工具调用与子图调用使用同一隔离语义

典型场景：外层 pi agent 判断当前问题适合由 `xxxGraph` 解决，于是调用该图注册出的工具，并通过工具参数传入完成任务所需的最小上下文。

目标数据流：

```text
外层 pi agent transcript / 当前 ReAct / 其它历史
                    │
                    │  不可见
                    ▼
       xxxGraph(input params)
                    │
          background = params
          frames = []
          scratch = {}
                    │
                    ▼
          图内 NodeScope / frames
                    │
                    │  仅最终结果越过边界
                    ▼
      outer tool result = GraphRunResult.result
```

硬性契约：

| 方向 | 允许穿越边界 | 禁止穿越边界 |
|------|--------------|--------------|
| 调用方 → 图 | 工具参数经 schema 校验后形成的 `background` / Entry input | 外层完整 transcript、外层 live ReAct、外层 frames、外层 scratch |
| 图 → 调用方 | END 边最终 `frame.result`、明确的 status/error | 图内 frames、节点 ReAct、skill 全文、mechanism 消息、`__graph_complete__` 轨迹 |

该契约与父图调用子图保持同构：**被调用图是函数，input 是唯一显式入参，最终 result 是唯一业务返回值。** 调用来源只影响适配方式，不改变图运行语义。

需要同时纠正当前两个实现缺口：

1. `executeGraph()` 当前返回 `Promise<void>`，图工具只能返回「执行完成」，没有返回 END 边的最终结果。目标形态必须改为 `Promise<GraphRunResult>`。
2. 当前所有调用来源都把图内消息写入同一个 pi session。对 graph tool 而言这既会造成返回后 transcript 泄漏，也会产生 streaming 重入等待环；默认路径必须迁移到独立子 AgentSession。命令等仍使用共享 session 的路径，则必须在非活动状态下继续清洗已关闭的图调用区段。

建议统一返回类型：

```typescript
interface GraphRunResult {
  graphId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>; // END 边最终 frame.result
  steps: number;
}
```

`GraphRunResult` 不包含 `frames`。完整帧栈只用于图内投影、debug trace 或未来显式诊断 API，不得通过普通图工具结果泄漏给调用方。

错误语义必须区分：

- 图按业务路径得到 `failed/cancelled`：正常返回结构化 `GraphRunResult`，由外层 agent 决定下一步。
- host 创建失败、模型不可用、工具缺失、Runtime invariant 破坏：graph tool 抛异常，让 pi 将其记录为真正的 tool error，不能伪装成业务失败。

tool result 的模型可见文本应设置明确大小上限；完整结构化结果可放入 `details` 供 UI/程序消费。发生截断时必须带 `truncated` 标志和可理解摘要，不能静默截断 JSON。

### 3.4 GraphCallScope：共享 session 路径的边界与审计协议

仅靠 NodeScope 只能隔离图运行期间的节点上下文。对于命令调用、现有共享 session 兼容路径和嵌套调试，需要为每次图调用追加语义化调用边界：

```typescript
// 图开始，位于外层 assistant tool-call 之后、首个图内消息之前
{
  customType: "loop_graph_call_start",
  content: "[Loop Graph call started: xxxGraph]",
  display: false,
  details: {
    protocol: 2,
    graphRunId,
    graphId,
    invocationKind: "tool" | "command" | "subgraph",
    parentGraphRunId?: string
  }
}

// 图结束，位于全部图内消息之后、外层 tool result 之前
{
  customType: "loop_graph_call_end",
  content: "[Loop Graph call completed: xxxGraph]",
  display: false,
  details: { protocol: 2, graphRunId, status }
}
```

共享 session 投影器承担两层处理：

1. **活动图内部**：只投影当前 NodeScope、当前图 frames 和当前节点 live ReAct，不投影调用方消息。
2. **返回调用方后**：从外层上下文中删除已闭合的 `GraphCallScope` 区段；外层 assistant 发出的 graph tool call 和 SDK 返回的最终 tool result 位于区段之外，因此正常保留。

共享 session 路径的图内 transcript 仍可保存在 session 文件和 debug log 中用于审计；graph tool 的子会话默认使用 in-memory session，结束后只保留显式 debug trace。这里的「完全隔离」指 **LLM 可见上下文隔离**，不承诺文件、数据库、网络调用等业务副作用回滚。

但 GraphCallScope 不能解决同一 agent loop 的重入问题，因此它不是 graph tool 的最终执行载体。graph tool 的默认路径必须使用下一节的独立子会话。

### 3.5 graph tool 必须使用独立执行载体

pi graph tool 的 `execute()` 发生在外层 agent 的 tool execution 期间。此时外层 session 仍处于 streaming；在同一 session 内调用：

```typescript
pi.sendMessage(nodePrompt, { triggerTurn: true })
```

不会立即启动一个嵌套 agent run，而是进入 steer/follow-up 队列。若 graph tool 同时 `await executeGraph()`，会形成以下等待环：

```text
外层 agent 等待 graph tool 返回
          ▲                 │
          │                 ▼
同一 session 的下一轮 ◀ 图等待内部 runAgent 完成
```

因此，同步 graph tool 若需要在图内运行 LLM，不能复用外层 `ExtensionAPI` 对应的 agent loop。目标实现应引入执行载体抽象：

```typescript
interface GraphExecutionHost {
  run(graph: Graph, request: GraphRunRequest): Promise<GraphRunResult>;
  dispose(): Promise<void> | void;
}
```

默认 graph tool 使用 `IsolatedSessionGraphHost`：

1. 从 tool `ExtensionContext` 获取 `cwd`、当前 model 和必要运行配置。
2. 使用 `createAgentSession()` + `SessionManager.inMemory(cwd)` 创建独立子 `AgentSession`。
3. 在子会话中以 runtime-only 模式安装 Loop Graph adapter，不重复注册对外 graph tools/commands。
4. 只把工具参数作为 `background` 写入子会话；不复制外层 messages、compaction summary 或 session entries。
5. 在子会话中执行整张图，得到 `GraphRunResult`。
6. `finally` 中 abort/dispose 子会话。
7. 将最终 result 编码为外层 graph tool result。

这与 pi 官方 subagent 示例的「独立上下文执行载体」方向一致，但本 SDK 优先采用进程内、in-memory `AgentSession`，因为 Graph 对象包含函数，无法安全地直接序列化给子进程。

必须显式解决子会话的工具供应问题：外层 `pi.getAllTools()` 只能给出工具元数据，不能复制工具实现。业务 extension 需通过 `IsolatedSessionGraphHost` 的资源/工具工厂向子会话注册图节点所需工具。建议新增非破坏性配置：

```typescript
interface LoopGraphExtensionOptions {
  // ...现有选项
  createToolGraphHost?: (ctx: ExtensionContext) => Promise<GraphExecutionHost>;
}
```

默认工厂负责 pi 内建工具和标准资源发现；使用业务自定义工具的图，应由业务 extension 提供 host factory 或可复用的 `ToolDefinition[]`。注册期/执行前仍需按 `Node.tools` 校验子 host 实际拥有的工具，不能假定外层工具自动可用。

隔离层级由此明确为：

| 调用形式 | 执行载体 | 上下文边界 |
|----------|----------|------------|
| 外层 pi agent → graph tool | 独立子 AgentSession | 物理 message history 隔离；只传 input/result |
| 顶层命令 → graph | 当前空闲 pi session | GraphCallScope + NodeScope 投影隔离 |
| 父图 → 子图 | 当前图执行载体内的新 AgentInstance | `frames=[]` + NodeScope 隔离 |

---

## 四、实施计划

拆成可独立验证的提交。

### Phase 0 — graph tool 独立执行载体可行性闸门

**状态：✅ 已完成。** `graph-execution-host.spike.test.ts` 共 29 条通过，其中端到端 completion、多次 completion 与并发 completion 使用真实 LLM 验证。

在改动主 Runtime 前先做最小 spike，必须证明：

1. graph tool `execute()` 内可以创建 in-memory `AgentSession` 并等待其完成，不依赖外层下一轮。
2. 子会话能够继承/显式选择当前 model、cwd、thinking level 和认证配置。
3. 子会话只加载允许的工具，且 `__graph_complete__` 能正常闭环。
4. outer `AbortSignal` 能终止子会话和图运行。
5. 子会话 dispose 后不遗留事件监听器、进程或未完成 Promise。
6. 外层下一次 provider request 只包含 graph tool call/result，不包含任何子会话 message。
7. 两个 graph tool 并发执行时各自持有独立 host/runtime，不共享 `activeRuntime`、frames、scratch 或完成信号。

若进程内 AgentSession 无法稳定承载所需业务工具，再评估独立 pi 子进程 + 注册图名/JSON 输入输出协议；不得退回同 session 同步重入作为默认实现。

### Phase 1 — 冻结现有行为（characterization tests）

**状态：✅ 已完成并迁移至 v2 契约。** 11 条 characterization tests 已从旧哨兵行为更新为 NodeScope visit/唯一性、时序与 fail-closed 契约。

新增测试，不改运行时：

| 测试场景 | 覆盖什么 |
|----------|----------|
| 双节点折叠 | 基准 |
| 同节点循环进入 | 哨兵递增计数 |
| 同 session 连续执行两张图 | `head` 边界 |
| 外层 agent 调用图工具 | 图内看不到外层 transcript，只看到 params/background |
| 图工具返回后外层继续推理 | 外层只看到 tool call + 最终 result，看不到图内 transcript |
| 子图嵌套 | 隔离 + 归约 |
| 节点内多次 `runAgent` | 多 completion |
| `frameFormatter` 自定义 | 透传 |
| agent-choice | CURRENT 段边列表 |
| mechanism 和 skill 的消息顺序 | 追加时序 |
| 找不到当前边界时的现有行为 | 降级路径 |

### Phase 2 — 引入内部作用域协议

**状态：✅ 已完成。** 已新增 `GraphRunRequest`、`GraphRunResult`、`GraphExecutionHost` 与 `IsolatedSessionGraphHost`，通过 9 条生命周期单元测试。runtime-only 子 adapter 已通过官方 in-memory AgentSession + resource loader 复用真实 Runtime；GraphRegistry 到独立 host 的最终接线仍待后续阶段。

新增内部类型：

```typescript
interface NodeScopeDescriptor {
  protocol: 2;
  graphRunId: string;
  instanceId: string;
  scopeId: string;
  graphId: string;
  nodeId: string;
  visit: number;
  depth: number;
}
```

同时新增图调用级作用域：

```typescript
interface GraphCallScopeDescriptor {
  protocol: 2;
  graphRunId: string;
  graphId: string;
  invocationKind: "tool" | "command" | "subgraph";
  parentGraphRunId?: string;
  depth: number;
}
```

`GraphRuntime` 改为维护：

- `graphRunId`
- `currentScope`
- 节点访问计数
- 调用深度
- 当前 `GraphCallScope`
- 当前调用来源 `invocationKind`

删除：

- `nodeMarker`
- `nextMarker()`
- `BOUNDARY_TYPE`
- 随机内容匹配逻辑

### Phase 3 — 用 NodeScope 替换哨兵

**状态：✅ 已完成。** 主 Runtime 已删除 `nodeMarker` / `nextMarker()` / `loop_graph_boundary` 路径；主图与子图进入节点均追加带结构化 details 的 `loop_graph_node_scope`。

调整节点进入顺序：

```
enterNode
→ 创建 NodeScope
→ 追加 CURRENT / NodeScope 消息
→ 追加 skill
→ 执行 mechanism
→ runAgent prompt
```

保持当前可见顺序不变：

```
COMPLETED
CURRENT
skill
mechanism context
prompt
live ReAct
```

纯代码节点如果完全不调用 agent，可以不写入 pi transcript，减少隐藏消息积累。

### Phase 4 — 重写 projection 为严格作用域投影

**状态：✅ 已完成。** 投影从尾部匹配当前 `scopeId`，只输出 frames + 当前 scope 后消息；缺失 scope 时只恢复 frames + 确定性 CURRENT。新增/更新 19 条 projection 与 characterization 测试，全量 138 项（含真实 LLM）通过。

新算法：

```typescript
const scopeIdx = findLastMatchingScope(messages, activeScope);

if (scopeIdx >= 0) {
  return [
    formatFrames(frames),
    ...messages.slice(scopeIdx),
  ];
}
```

找不到作用域时必须 fail closed：

- 不返回原始完整 transcript
- 输出 frames + 当前节点恢复消息
- 记录结构化诊断
- 必要时终止当前节点并明确报错

**禁止**保留现在的「全部消息作为 head」降级。

共享 session 的 projection 不能只在 `activeRuntime != null` 时运行。它还必须识别并剔除已经闭合的 `GraphCallScope` 区段，保证命令调用和兼容路径结束后，后续普通对话不会重新看到图内 transcript。默认 graph tool 因运行于独立子会话，不依赖该清洗获得隔离。

建议把纯函数拆成两层：

```typescript
stripClosedGraphCalls(messages)       // 所有状态均执行，清除已结束图调用内部消息
projectActiveNodeScope(messages, ...) // 有活动图时执行，构造 frames + 当前节点视图
```

这样「调用级隔离」和「节点级折叠」不会混成一个难以验证的下标算法。

### Phase 5 — 增加 compaction 协同

**状态：✅ 已完成基础协同。** 运行时监听 `session_compact`；仅当图节点活跃时，同步在消息流末尾重发相同 `scopeId` 的 NodeScope checkpoint，并记录 `compactionGeneration`、`reason` 与 `willRetry`。因此 overflow retry 将从新 checkpoint 进行严格投影，frames 不变，scope 前 compaction summary 不会进入图上下文。尚未实现自定义 compaction 或主动调用 `ctx.compact()`，两者均不属于本阶段。

注册：

```typescript
pi.on("session_compact", ...)
```

图运行期间：

- 重新发出当前 NodeScope checkpoint
- 保留同一 `AgentInstance.frames`
- 记录 compaction generation
- `willRetry: true` 时保证 retry 使用新作用域
- context 投影排除 graph run 中产生的 `compactionSummary`

**不做**：

- 不在每个节点结束时调用 `ctx.compact()`
- 不用 LLM compaction summary 替代 `ContextFrame`
- 不关闭 pi 全局 auto-compaction
- 不覆盖图之外的正常 session compaction 行为

### Phase 6 — 统一主图和子图循环

> 设计补充：根据 [ADR-0001](../adr/0001-graph-invocation-boundaries.md)，统一循环不能再把所有嵌套图等同为隔离子图。内部执行核心应支持 `compose`、`call`、`delegate` 三种边界；本阶段先保持现有 `kind: "graph" = call` 的兼容语义，再为 compose 帧段和 delegate host 留出明确策略接口。

[loop-graph-extension.ts](/src/adapter/loop-graph-extension.ts:368) 的子图循环复制了主图循环。

抽出：

```typescript
runGraphLoop({
  runtime,
  nodeContext,
  graph,
  background,
  maxSteps,
  invocationKind
})
```

主图负责 UI 完成消息，子图负责将最终帧归约为 `NodeCompletion`；节点进入、作用域、投影、路由、工具恢复只保留一份实现。

同时统一图执行返回契约：

```typescript
runGraphLoop(...): Promise<GraphRunResult>
executeGraph(...): Promise<GraphRunResult>
```

调用适配：

| 调用来源 | 入参 | 返回处理 |
|----------|------|----------|
| pi graph tool | tool params → 独立 host background | 子 AgentSession 中运行，`GraphRunResult.result` 编码为外层 tool result |
| 命令 | `parseArgs()` → background | UI 展示完成状态；需要时展示最终结果 |
| 父图 graph node | `NodeInput.data` → child background | child final result → 父图该节点的 `NodeCompletion.result` |

当前子图实现把 `childFrames` 放入父图 `NodeCompletion.result`。这与「父图只看子图结果、不偷看内部历史」的原则不完全一致。重构后默认只返回 `finalResult`；子图 frames 留在 debug trace，若未来需要公开诊断信息，应通过独立、显式 opt-in 的 trace API，而不是普通业务结果。

### Phase 7 — 完整验证矩阵

必须新增以下测试：

| 测试 | 验证点 |
|------|--------|
| compaction 保留 scope | 哨兵不丢 |
| compaction 删除 scope 后重新锚定 | fail-closed 行为 |
| overflow + `willRetry` | retry 路径 |
| compaction summary 不进入活动图上下文 | 隔离 |
| compaction 前后 frames 完全一致 | 确定性 |
| 循环节点每次 visit 使用不同 scope | 区分 |
| 父图 frames 对子图不可见 | 隔离 |
| 子图 compaction 后恢复父图 | 嵌套 |
| 两个 SDK 工厂实例不串 scope | 实例隔离 |
| scope metadata 不出现在 LLM 内容中 | 隐藏 |
| scope 缺失时 fail closed | 防御 |
| frameFormatter 返回 null | 自定义 |
| skill / mechanism 不被误删 | 内容完整性 |
| 图结束后普通 pi session 恢复正常上下文 | 退出 |
| 图工具只接收显式 params | 调用方 → 图隔离 |
| 图工具返回 END 最终 result | 结果契约 |
| 图工具返回后外层看不到内部 ReAct | 图 → 调用方隔离 |
| graph tool 不在外层 streaming session 中调用 runAgent | 无重入死锁 |
| 外层 abort graph tool | 子 AgentSession 立即 abort/dispose |
| 子 host 缺少 Node.tools | 执行前明确失败，不静默回退外层工具 |
| 连续调用同一图工具两次 | 两个独立子 AgentSession、AgentInstance 和 frames 不串线 |
| 两个图工具并发执行 | host、完成信号、工具集和结果不串线 |
| 业务 failed 与基础设施异常 | 前者结构化返回，后者 tool error |
| 超大最终 result | 有界输出、显式 truncated，不产生无效 JSON |
| 图工具内部再调用子图 | 嵌套调用边界正确配对 |
| 共享 session 图异常终止仍写入 call_end | 不留下未闭合泄漏区段 |

验收基线：

```text
现有 80 tests 全部通过
新增 compaction / scope 测试全部通过
tsc --noEmit 通过
debug log 中无 loop_graph_boundary
长节点强制 compact 后仍能 __graph_complete__
外层 agent 调用 graph tool 后只收到 END 最终 result
graph tool 返回后的下一次 provider request 不含任何图内节点 transcript
```

### Phase 8 — 兼容与回滚

保留非破坏性选项：

```typescript
contextProjectionMode?: "scope-v2" | "legacy-sentinel"
```

- 默认：`scope-v2`
- `legacy-sentinel`：只作为紧急回滚通道
- 标记 deprecated
- 下一次次版本稳定后删除旧实现

该选项只回滚 NodeScope 投影算法，不得回滚 graph tool 的独立 `IsolatedSessionGraphHost`。工具调用隔离和无重入死锁属于新的硬性契约，不允许通过兼容开关降级。

公共的 Graph、Node、Edge、ContextFrame API 不变，业务图无需修改。

`executeGraph()` 从 `Promise<void>` 改为 `Promise<GraphRunResult>` 属于返回能力增强；现有仅 `await` 且忽略返回值的调用方式保持兼容。GraphRegistry 的工具结果文本将从固定「图执行完成」改为包含最终结构化结果，需增加回归测试。

### Phase 9 — 同步文档

实施时必须同步更新：

| 文档 | 更新内容 |
|------|----------|
| `Agent.md` | 文档地图 + 核心机制 |
| `docs/设计/loop-graph-sdk-design.md` | 设计演进附录 |
| `docs/设计/entry-message-format.md` | 修正 compaction 后行为描述 |
| `docs/形态/developer-guide.md` | NodeScope 说明 |
| `docs/形态/implementation-status.md` | 已验证 + 已关闭缺口 |
| `docs/README.md` | 如新增独立设计文档则注册 |

> 这项决策同时具备难回退、存在真实权衡、未来维护者容易疑惑三个条件，适合在设计演进中形成正式决策记录。

---

## 五、不改变的部分（重申）

- `AgentInstance.frames`
- `ContextFrame`
- `Edge.migrate`
- 子图隔离栈
- `frameFormatter`
- COMPLETED / CURRENT 对外格式
- 「框架不调用 LLM 摘要」原则

---

## 六、风险与依赖

| 风险 | 缓解 |
|------|------|
| pi 内部 compaction 行为变更 | 通过 characterization tests 及时检测 |
| `details` 字段在 compaction 后是否保留 | 通过 `session_compact` 重新发出结构化 checkpoint；仍无法恢复时 fail closed，不采用可被正文伪造的 content 前缀降级 |
| 旧哨兵代码删除导致隐蔽回归 | Phase 8 保留 `legacy-sentinel` 回滚通道 |
| 子图循环统一引入新 bug | Phase 6 独立提交，可单独 revert |
| 只在活动图期间过滤，返回后内部消息泄漏 | 使用持久的 GraphCallScope start/end 区段清洗；测试外层下一轮 provider request |
| graph tool 在同一 streaming session 内重入死锁 | 默认使用独立 `IsolatedSessionGraphHost`；Phase 0 先验证 |
| 子 AgentSession 无法获得业务工具实现 | 由业务 extension 提供 host/tool factory；对子 host 重新执行工具存在性校验 |
| 子会话加载当前 extension 导致 graph tool 递归注册 | child adapter 使用 runtime-only 模式，不注册 invocation/command/demo graphs |
| 子会话资源、监听器或请求泄漏 | tool signal 贯穿 host；`finally` abort + dispose；增加泄漏测试 |
| 工具结果过大重新撑爆外层上下文 | 对模型可见 content 设置上限；完整结果进入 details 或显式外部引用 |
| 业务失败和基础设施错误混淆 | `GraphRunResult.status` 只表达业务终态；host/runtime 异常直接 throw |
| 图异常导致没有 call_end | `finally` 中闭合调用作用域；异常也返回结构化 failed 结果 |
| compaction 切断 GraphCallScope start/end | `session_compact` 重建活动调用 checkpoint；closed-scope 清洗加入跨 compaction 测试 |
| 子图 frames 作为 result 泄漏 | 普通返回只含 final result；frames 转移到 debug trace |

pi 最低版本要求：0.80.3（提供 `session_compact`、`createAgentSession`、in-memory `SessionManager` 等能力）。

---

## 七、后续

重构完成后，以下工作获得可靠基础：

- session 续跑（帧持久化 + 恢复 NodeScope）
- 多 agent 通讯（`docs/设计/communication-design.md`）
- ReAct 透传（`rawSections` 随 NodeScope 自然可用）
- 图工具成为真正的函数式能力单元：外层 agent 只负责选择图、准备 input、消费最终 result
