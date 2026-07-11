
# 节点作用域投影重构计划

> 2026-07-11 | 优先级：高
>
> 建议在 session 续跑、帧持久化和多 agent 工作开始前完成。

---

## 一、目标

把「随机隐藏哨兵 + transcript 下标切分」改成「语义化节点作用域 + compaction 协同投影」。

同时统一图调用协议，但不再把所有图调用强制成同一种上下文边界。用户命令与 agent 工具统一为 `GraphRunRequest → GraphRunResult` 并默认使用 `delegate`；父图复用图时显式选择 `compose`、`call` 或 `delegate`。`call/delegate` 只通过参数与结果交互，`compose` 可读取父 frames 并在同一 AgentInstance 上形成必须折叠的临时帧段。

本计划中的规范术语为**图调用边界（Graph Invocation Boundary）**。它描述调用方与被调用图之间的上下文共享契约，不等同于 NodeScope，也不等同于调用入口：

- `GraphCallScope` 管理「调用方 ↔ 整张图」的边界。
- `NodeScope` 管理「图内前序节点 ↔ 当前节点」的边界。
- `ContextFrame` 管理图内已完成节点的确定性业务记忆。
- `invocationKind` 记录命令、工具、父图或 API 等调用来源；`boundary` 独立选择 `compose/call/delegate`。

### 保持不变

| 不变项                       | 说明                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `AgentInstance.frames`     | 节点帧与 call 语义不变；compose 将新增有界帧段归约能力                                |
| `ContextFrame`             | 不变                                                                                  |
| `Edge.migrate`             | 不变                                                                                  |
| 现有`kind: "graph"`        | 默认保持`call` 隔离栈语义，避免破坏兼容性                                           |
| `frameFormatter`           | 签名和用法不变                                                                        |
| COMPLETED / CURRENT 对外格式 | 对外不变                                                                              |
| 「框架不调用 LLM 摘要」原则  | 不变                                                                                  |
| 显式越界数据                 | call/delegate 只走 input/result；compose 的父 frames/scratch 共享由 boundary 显式声明 |

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

### 3.3 图调用入口与执行边界正交

用户命令、agent 工具、父图节点和高级 API 是调用入口；`compose/call/delegate` 是执行边界。入口只负责把外部输入规范化为 `GraphRunRequest`，不能在 Registry、命令 handler 或 tool execute 中各自复制图运行逻辑。

```typescript
type GraphInvocationKind = "command" | "tool" | "graph-node" | "api";
type GraphInvocationBoundary = "compose" | "call" | "delegate";

interface GraphRunRequest {
  background: Record<string, unknown>;
  invocationKind: GraphInvocationKind;
  boundary: GraphInvocationBoundary;
  signal?: AbortSignal;
}
```

三种边界的硬性契约：

| 边界         | AgentSession | AgentInstance | 被调用图可见内容                                               | 返回处理                                     |
| ------------ | ------------ | ------------- | -------------------------------------------------------------- | -------------------------------------------- |
| `compose`  | 复用         | 复用          | 父 background、父已完成 frames、共享 scratch，以及调用点 input | 子图新增帧段必须折叠为 graph node completion |
| `call`     | 复用         | 新建          | 仅显式 background；`frames=[]`、新 scratch                   | 仅最终 status/result 返回父图                |
| `delegate` | 新建         | 新建          | 仅显式 background；物理消息历史隔离                            | 仅`GraphRunResult` 越过 host 边界          |

默认策略：

- 现有 `kind: "graph"` 缺省为 `call`，保持当前行为。
- graph node 可显式选择 `compose` 或 `delegate`。
- 用户命令与 agent 工具统一默认 `delegate`，保证二者机制一致。
- 高级 API 必须显式选择边界，不提供根据当前 streaming 状态猜测的隐式策略。

`GraphRunResult` 是所有边界的统一业务返回：

```typescript
interface GraphRunResult {
  graphId: string;
  status: "ok" | "failed" | "cancelled";
  result: Record<string, unknown>;
  steps: number;
}
```

它不包含 frames、ReAct 或 trace。业务 `failed/cancelled` 正常返回；host 创建失败、工具缺失、模型不可用和 Runtime invariant 破坏必须抛出基础设施异常。

### 3.4 compose：同一 AgentInstance 上的有界帧段

`compose` 不是无边界内联。Runtime 在进入子图前记录父 frames 的基线，在同一 AgentInstance 上执行子图，子图因此能够读取父图已完成 frames；每个内部节点的 live ReAct 仍由 NodeScope 隔离。

```text
父 frames: [A, B]
               └─ baseIndex = 2
compose 执行: [A, B, C, D, E]
退出并折叠:  [A, B] + graph-node completion
                         │
                         └─ 再由父 Edge.migrate 生成一个父级 ContextFrame
```

调用点拥有 fold 策略，同一张 Graph 在不同父图中可以采用不同信息保留方式：

```typescript
interface ComposeFoldInput {
  segment: readonly ContextFrame[];
  finalResult: GraphRunResult;
}

type ComposeFoldResult = Pick<NodeCompletion, "status" | "result">;
type ComposeFrameFolder = (input: ComposeFoldInput) => ComposeFoldResult;

type GraphNode = {
  kind: "graph";
  id: string;
  subGoal: string;
  graph: Graph;
  boundary?: "compose" | "call" | "delegate"; // 缺省 call
  fold?: ComposeFrameFolder;                    // 仅 compose 有效
};
```

fold 的默认实现只透传子图最终 status/result，Runtime 强制使用父 graph node 的 id 构造 `NodeCompletion`，调用点不能伪造节点身份。开发者若需要无损保留，可以显式把整个 segment 编码到 result；但 Runtime 仍必须截断原始 segment，禁止未关闭内部帧直接泄漏到父级。

异常语义：

- 正常的 `ok/failed/cancelled` 都执行 fold。
- fold 抛错或 Runtime 基础设施异常时，Runtime 必须先回滚到 `baseIndex`，再向上抛错。
- 完整内部帧、回滚原因和嵌套路径写入 trace；不得为了审计而保留在父 frames。
- 父 Edge 仍是最终记忆决策者：fold 产出 NodeCompletion，Edge.migrate 才产出父级 ContextFrame。

### 3.5 call：同会话中的逻辑函数边界

`call` 使用同一个 AgentSession，但创建新的 AgentInstance、frames 和 scratch。它复用模型、工具实现、UI 与 compaction 生命周期，适合低开销的同步函数式图调用。

`GraphRuntime.callStack` 应真正承担调用栈职责，而不是为主图和子图创建两套 GraphRuntime：

```typescript
interface CallFrame {
  graph: Graph;
  instance: AgentInstance;
  boundary: "root" | "compose" | "call";
  callBackground: Record<string, unknown>;
  localGoal: string;
  localMechanisms: readonly Mechanism[];
  parentNodeId?: string;
  frameBase?: number; // compose only
  currentNodeId: string | null;
}
```

- `call` push 新 Instance，返回时 pop，只交付最终 result。
- `compose` push 同一 Instance 的作用域帧，返回时折叠 frame segment。
- Entry.guard/mapInput 读取当前 CallFrame.callBackground；compose 不改写父 `instance.background`。
- Graph.goal 与 Graph.mechanisms 是当前 CallFrame 的局部执行配置；compose 退出后自然恢复父配置。
- `delegate` 不进入当前 Runtime callStack，而是通过 GraphExecutionHost 建立新会话和新 Runtime。
- NodeScope 的 `depth` 来自统一 callStack，嵌套路径不再依赖切换多个 `activeRuntime`。

### 3.6 GraphCallScope：共享 session 路径的边界与审计协议

仅靠 NodeScope 只能隔离图运行期间的节点上下文。对于 `compose/call`、高级共享 session API 和嵌套调试，需要为每次图调用追加语义化调用边界：

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
    invocationKind: "tool" | "command" | "graph-node" | "api",
    boundary: "compose" | "call",
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

但 GraphCallScope 不能解决同一 agent loop 的重入问题，因此它不是 command/tool 的默认执行载体。二者统一使用下一节的 delegate host。

### 3.7 delegate：命令与工具统一使用独立执行载体

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

默认 command 和 graph tool 都通过同一 `GraphInvoker` 创建一次性的 `IsolatedSessionGraphHost`：

1. 从 tool `ExtensionContext` 获取 `cwd`、当前 model 和必要运行配置。
2. 使用 `createAgentSession()` + `SessionManager.inMemory(cwd)` 创建独立子 `AgentSession`。
3. 在子会话中以 runtime-only 模式安装 Loop Graph adapter，不重复注册对外 graph tools/commands。
4. 只把工具参数作为 `background` 写入子会话；不复制外层 messages、compaction summary 或 session entries。
5. 在子会话中执行整张图，得到 `GraphRunResult`。
6. `finally` 中 abort/dispose 子会话。
7. 将最终 result 交给入口适配器：command 做 UI 展示，tool 编码为 tool result。

这与 pi 官方 subagent 示例的「独立上下文执行载体」方向一致，但本 SDK 优先采用进程内、in-memory `AgentSession`，因为 Graph 对象包含函数，无法安全地直接序列化给子进程。

必须显式解决子会话的工具供应问题：外层 `pi.getAllTools()` 只能给出工具元数据，不能复制工具实现。业务 extension 需通过 `IsolatedSessionGraphHost` 的资源/工具工厂向子会话注册图节点所需工具。建议新增非破坏性配置：

```typescript
interface LoopGraphExtensionOptions {
  // ...现有选项
  createDelegateHost?: (ctx: ExtensionContext) => Promise<GraphExecutionHost>;
}
```

默认工厂负责 pi 内建工具和标准资源发现；使用业务自定义工具的图，应由业务 extension 提供 host factory 或可复用的 `ToolDefinition[]`。注册期/执行前仍需按 `Node.tools` 校验子 host 实际拥有的工具，不能假定外层工具自动可用。

隔离层级由此明确为：

| 调用形式                    | 执行载体                     | 上下文边界                       |
| --------------------------- | ---------------------------- | -------------------------------- |
| 用户 → graph command       | 独立子 AgentSession          | delegate；只传 params/result     |
| 外层 pi agent → graph tool | 独立子 AgentSession          | delegate；只传 params/result     |
| 父图 → compose graph node  | 当前 Session/Instance        | 共享父 frames；帧段强制折叠      |
| 父图 → call graph node     | 当前 Session、新 Instance    | `frames=[]`；只传 input/result |
| 父图 → delegate graph node | 独立子 AgentSession/Instance | 只传 input/result                |

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

| 测试场景                      | 覆盖什么                                                  |
| ----------------------------- | --------------------------------------------------------- |
| 双节点折叠                    | 基准                                                      |
| 同节点循环进入                | 哨兵递增计数                                              |
| 同 session 连续执行两张图     | `head` 边界                                             |
| 外层 agent 调用图工具         | 图内看不到外层 transcript，只看到 params/background       |
| 图工具返回后外层继续推理      | 外层只看到 tool call + 最终 result，看不到图内 transcript |
| 子图嵌套                      | 隔离 + 归约                                               |
| 节点内多次`runAgent`        | 多 completion                                             |
| `frameFormatter` 自定义     | 透传                                                      |
| agent-choice                  | CURRENT 段边列表                                          |
| mechanism 和 skill 的消息顺序 | 追加时序                                                  |
| 找不到当前边界时的现有行为    | 降级路径                                                  |

### Phase 2 — 引入内部作用域协议

**状态：✅ 基础切片已完成。** 已新增 `GraphRunRequest`、`GraphRunResult`、`GraphExecutionHost` 与 `IsolatedSessionGraphHost`，通过 9 条生命周期单元测试。runtime-only 子 adapter 已通过官方 in-memory AgentSession + resource loader 复用真实 Runtime；boundary 字段、GraphCallScope、统一 callStack 与 GraphRegistry 到独立 host 的接线分别留到 Phase 6、9、10。

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

计划新增图调用级作用域（尚未实现）：

```typescript
interface GraphCallScopeDescriptor {
  protocol: 2;
  graphRunId: string;
  graphId: string;
  invocationKind: "tool" | "command" | "graph-node" | "api";
  boundary: "compose" | "call";
  parentGraphRunId?: string;
  depth: number;
}
```

`GraphRuntime` 已维护 NodeScope 所需状态；以下调用级状态将在 Phase 7/9 补齐：

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

### Phase 6 — 固化调用协议与类型边界

**目标**：先让“来源”和“边界”在类型系统中分离，不改现有运行行为。

修改建议：

- `src/adapter/graph-execution-host.ts`
  - `GraphInvocationKind` 改为 `command | tool | graph-node | api`。
  - 新增 `GraphInvocationBoundary = compose | call | delegate`。
  - `GraphRunRequest` 增加必填 `boundary`；内部兼容构造器为旧调用补 `call`。
- `src/type.ts`
  - graph node 新增可选 `boundary`，缺省为 `call`。
  - 新增 compose-only `fold` 类型；非 compose 配置 fold 在校验期报错。
- `src/validate.ts`
  - 校验 boundary/fold 组合、delegate host 可用性声明、嵌套图循环引用。
- `src/index.ts`
  - 导出稳定的边界、fold 输入和调用协议类型。

兼容类型草案：

```typescript
type GraphNode = {
  kind: "graph";
  id: string;
  subGoal: string;
  graph: Graph;
  boundary?: GraphInvocationBoundary; // default: call
  fold?: ComposeFrameFolder;          // compose only
};
```

验收：

- 所有旧 Graph 无需修改即可编译，行为仍为 call。
- `compose + fold`、`compose + 默认 fold`、`delegate` 类型可表达。
- `call/delegate + fold` 明确校验失败。
- `invocationKind` 不再出现含混的 `subgraph` 值。

### Phase 7 — 抽取单一 runGraphLoop，保持 call 行为等价

**目标**：删除 [loop-graph-extension.ts](/src/adapter/loop-graph-extension.ts) 中主图与 `runSubgraphInExtension` 的双循环，但暂不实现 compose/delegate graph node。

抽出不负责 UI、Registry 或 host 生命周期的执行核心：

```typescript
interface RunGraphLoopRequest {
  runtime: GraphRuntime;
  graph: Graph;
  background: Record<string, unknown>;
  boundary: "root" | "call" | "compose";
  parentNodeId?: string;
  maxSteps: number;
  signal?: AbortSignal;
}

runGraphLoop(request): Promise<GraphRunResult>;
```

结构要求：

- `GraphRuntime.callStack` 成为同一 Session 内唯一调用栈。
- root push 新 Instance；call push 新 Instance；两者走同一节点执行、机制、工具、NodeScope、路由和 END 逻辑。
- 删除创建第二个 `GraphRuntime` / `PiNodeContext` 的子图复制循环。
- UI success/error 消息移到入口适配器；执行核心只返回结果或抛基础设施异常。
- 工具保存恢复使用 `try/finally` 包裹每次节点执行，异常和取消路径也恢复。
- `activeRuntime` 只指向当前 Session 的唯一 Runtime；NodeScope depth 来自 callStack。

验收：

- 当前 call 子图的 19 条主运行时测试行为等价。
- 嵌套 call、循环、agent-choice、skill、mechanism、compaction checkpoint 全部复用同一循环。
- 子图结果只含最终 result，不含 child frames。
- 基础设施异常不再被执行核心伪装成业务 `failed`；入口适配器决定展示方式。

### Phase 8 — 实现 compose 帧段与强制归约

**目标**：在同一 AgentInstance 上实现真正的图组合，同时保持节点 ReAct 隔离。

Runtime 增加显式帧段操作，禁止调用方直接操作数组下标：

```typescript
interface FrameSegmentScope {
  id: string;
  graphId: string;
  parentNodeId: string;
  baseIndex: number;
  depth: number;
}

beginFrameSegment(...): FrameSegmentScope;
readFrameSegment(scope): readonly ContextFrame[];
rollbackFrameSegment(scope): void;
closeFrameSegment(scope, completion): NodeCompletion;
```

执行顺序：

```text
记录 baseIndex
→ push compose CallFrame（复用 parent AgentInstance）
→ child Entry / nodes 在父 frames 上继续生长
→ 得到 child GraphRunResult
→ 截取只读 segment 快照
→ 调用 graphNode.fold 或默认 fold
→ 无论 fold 成功与否都截断到 baseIndex
→ pop compose CallFrame
→ 将折叠后的 NodeCompletion 交给父 Router/Edge
```

明确契约：

- compose 子图可见父 background、父 frames、共享 scratch；不得创建新 AgentInstance。
- child Graph.goal 作为当前 CallFrame 的局部目标，不改写 `instance.globalGoal`。
- child graph mechanisms 作为调用帧局部机制叠加，退出后撤销；不得永久写入父 instance 配置。
- 默认 fold 只返回 child status/result。
- 自定义 fold 接收冻结的 segment 快照，不能修改 live frames。
- 业务 `failed/cancelled` 仍执行 fold；基础设施错误或 fold 抛错执行 rollback 后继续抛出。
- trace 记录完整 segment、fold 结果和 rollback；frames 只保留父 Edge 最终写入的一帧。

必须新增测试：

- compose 读取父 frames，并共享 instance.id/scratch。
- compose 内部每个节点仍使用独立 NodeScope，前序 ReAct 被折叠。
- 正常、failed、cancelled 均关闭 segment。
- fold 抛错、节点抛错、abort、maxSteps 均不残留内部 frames。
- 默认 fold 不泄漏 frames；全量 fold 可显式传出完整 segment。
- 两层 compose、compose→call、call→compose 的 depth 和恢复正确。

### Phase 9 — 完成 call 与 GraphCallScope 的统一实现

**目标**：把当前隔离子图正式收敛为 call 策略，并完成共享 Session 的调用区段审计。

- call 创建新 AgentInstance、frames、scratch，但复用 Session/Runtime/工具实现。
- 每次 compose/call 写入 `loop_graph_call_start/end`，details 同时记录 invocationKind 与 boundary。
- `call_end` 在 `finally` 写入；业务失败、abort 和异常均不得留下未闭合区段。
- context 处理拆为：

```typescript
stripClosedGraphCalls(messages);
projectActiveNodeScope(messages, runtime);
```

- call 返回时恢复父 CallFrame、NodeScope 状态和工具集。
- 父图只收到 NodeCompletion status/result；child frames 仅进入 trace。

验收：连续图调用、嵌套 call、compaction 切断 start/end、异常退出后的下一次普通 provider request 均不包含已闭合图内 transcript。

### Phase 10 — command/tool/graph-node 统一接入 delegate host

**目标**：让用户命令和 agent 工具真正使用完全相同的图执行机制，并允许父图显式 delegate。

新增入口无关的调用器：

```typescript
interface GraphInvoker {
  invoke(graph: Graph, request: GraphRunRequest): Promise<GraphRunResult>;
}

interface LoopGraphExtensionOptions {
  createDelegateHost?: (context: GraphHostContext) => Promise<GraphExecutionHost>;
}
```

接线要求：

- `GraphRegistry` 只负责 parse/schema 与展示适配，不再持有共享 Session `executeGraph` 闭包。
- command 和 tool 都构造 `boundary: "delegate"` 的同一种 request，并为每次调用创建独立 host。
- command：await result 后通过 UI 展示；tool：相同 result 编码为 content/details。
- graph node `boundary: "delegate"` 复用同一 GraphInvoker，只传 `NodeInput.data`，返回 NodeCompletion。
- host 必须在 `finally` 执行 abort → dispose；每次并发调用拥有独立 host。
- 子 Session 使用 runtime-only adapter；不得注册 command/tool，也不得复制外层 transcript。
- 移除固定 `compaction.enabled: false`：改为显式 host 配置，默认遵循 pi compaction，并复用 Phase 5 checkpoint。
- 子 host 工具供应按实际 `ToolDefinition[]` 校验，禁止只复制工具名称。
- tool result 设置模型可见大小上限，截断时返回有效 JSON 和 `truncated: true`。

验收：同一张图通过 command 与 tool 获得等价 GraphRunResult；两者都创建独立 Session，外层只看到调用与最终结果。

### Phase 11 — 完整验证矩阵

必须新增以下测试：

| 测试                                                  | 验证点                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- |
| compaction 保留 scope                                 | checkpoint 可重新锚定                                   |
| compaction 删除 scope 后重新锚定                      | fail-closed 行为                                        |
| overflow +`willRetry`                               | retry 路径                                              |
| compaction summary 不进入活动图上下文                 | 隔离                                                    |
| compaction 前后普通节点 frames 完全一致               | 确定性                                                  |
| 循环节点每次 visit 使用不同 scope                     | 区分                                                    |
| compose 可见父 frames                                 | 共享栈语义                                              |
| compose 退出后内部 segment 只剩一个父帧               | 强制折叠                                                |
| compose 默认 fold 不泄漏 frames                       | 最小返回                                                |
| compose 全量 fold 显式保留 segment                    | 开放性                                                  |
| compose 异常/abort/fold throw 回滚 segment            | 栈安全                                                  |
| call 看不到父 frames/scratch                          | 逻辑隔离                                                |
| call 返回后恢复父 Instance/NodeScope                  | 调用栈恢复                                              |
| delegate 看不到父 transcript/frames/scratch           | 物理隔离                                                |
| compose→call→compose 嵌套                           | 混合边界正确                                            |
| 子调用 compaction 后恢复父图                          | 嵌套                                                    |
| 两个 SDK 工厂实例不串 scope                           | 实例隔离                                                |
| scope metadata 不出现在 LLM 内容中                    | 隐藏                                                    |
| scope 缺失时 fail closed                              | 防御                                                    |
| frameFormatter 返回 null                              | 自定义                                                  |
| skill / mechanism 不被误删                            | 内容完整性                                              |
| 图结束后普通 pi session 恢复正常上下文                | 退出                                                    |
| command/tool 生成等价 GraphRunRequest                 | 入口统一                                                |
| command/tool 只接收显式 params                        | 调用方 → 图隔离                                        |
| 图工具返回 END 最终 result                            | 结果契约                                                |
| 图工具返回后外层看不到内部 ReAct                      | 图 → 调用方隔离                                        |
| graph tool 不在外层 streaming session 中调用 runAgent | 无重入死锁                                              |
| 外层 abort graph tool                                 | 子 AgentSession 立即 abort/dispose                      |
| 子 host 缺少 Node.tools                               | 执行前明确失败，不静默回退外层工具                      |
| 连续调用同一图工具两次                                | 两个独立子 AgentSession、AgentInstance 和 frames 不串线 |
| 两个图工具并发执行                                    | host、完成信号、工具集和结果不串线                      |
| 业务 failed 与基础设施异常                            | 前者结构化返回，后者 tool error                         |
| 超大最终 result                                       | 有界输出、显式 truncated，不产生无效 JSON               |
| delegate 图内部再 compose/call/delegate               | 嵌套调用边界正确配对                                    |
| 共享 session 图异常终止仍写入 call_end                | 不留下未闭合泄漏区段                                    |
| invocationKind 与 boundary 任意合法组合               | 两个维度不耦合                                          |
| call/delegate 配置 fold                               | 注册期明确失败                                          |

验收基线：

```text
现有 141 tests 全部通过
新增 compaction / scope 测试全部通过
tsc --noEmit 通过
debug log 中无 loop_graph_boundary
长节点强制 compact 后仍能 __graph_complete__
用户命令与 agent graph tool 使用同一 delegate invoker
外层调用 graph 后只收到 END 最终 result
delegate 返回后的下一次 provider request 不含任何图内节点 transcript
compose/call/delegate 混合嵌套后 callStack、frames、工具集全部恢复
```

### Phase 12 — 兼容、迁移与回滚

兼容原则：

- `GraphNode.boundary` 可选，缺省 `call`；已有业务图无需修改。
- `ContextFrame`、`Edge.guard`、`Edge.migrate` 和 `frameFormatter` 签名不变。
- `executeGraph()` 保留为高级低层 API，但必须显式说明它运行于当前 Session；新业务入口使用 `GraphInvoker`。
- `GraphRunResult` 返回增强保持兼容：已有只 await、不读取返回值的代码继续工作。
- command/tool 切换 delegate 是有意行为变更，发布说明必须突出：内部 transcript 不再出现在外层 Session，业务自定义工具需要提供 host tool factory。

回滚单位按提交拆分：

1. Phase 6 纯类型协议。
2. Phase 7 单一循环，保持 call 等价。
3. Phase 8 compose，仅新增能力，可单独关闭公开入口。
4. Phase 9 GraphCallScope 清洗。
5. Phase 10 delegate Registry 接线。

不恢复 `legacy-sentinel`：随机哨兵路径已删除，重新引入会破坏 Phase 4 的 fail-closed 安全契约。若新边界实现出现问题，只允许回滚 compose/delegate 接线，NodeScope v2 保持不变。

### Phase 13 — 同步文档与发布说明

实施时必须同步更新：

| 文档                                             | 更新内容                        |
| ------------------------------------------------ | ------------------------------- |
| `Agent.md`                                     | 文档地图 + 核心机制             |
| `docs/设计/loop-graph-sdk-design.md`           | 设计演进附录                    |
| `docs/设计/entry-message-format.md`            | 修正 compaction 后行为描述      |
| `docs/形态/developer-guide.md`                 | NodeScope 说明                  |
| `docs/形态/implementation-status.md`           | 已验证 + 已关闭缺口             |
| `docs/README.md`                               | 如新增独立设计文档则注册        |
| `docs/adr/0001-graph-invocation-boundaries.md` | 实际 API 名称、默认值与后果核对 |

发布说明必须包含：旧 graph node 默认行为不变；command/tool 改为统一 delegate；compose 的 frames 共享范围、强制 fold 与异常回滚保证；trace 与 frames 的职责分离。

> 这项决策同时具备难回退、存在真实权衡、未来维护者容易疑惑三个条件，适合在设计演进中形成正式决策记录。

---

## 五、不改变的部分（重申）

- `AgentInstance.frames` 的元素类型与节点折叠来源；compose 只新增有界 segment 的结构化归约
- `ContextFrame`
- `Edge.migrate`
- 现有 `call` 子图隔离栈
- `frameFormatter`
- COMPLETED / CURRENT 对外格式
- 「框架不调用 LLM 摘要」原则

---

## 六、风险与依赖

| 风险                                              | 缓解                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| pi 内部 compaction 行为变更                       | 通过 characterization tests 及时检测                                                                               |
| `details` 字段在 compaction 后是否保留          | 通过`session_compact` 重新发出结构化 checkpoint；仍无法恢复时 fail closed，不采用可被正文伪造的 content 前缀降级 |
| NodeScope 重构出现隐蔽回归                        | 保持 Phase 4 fail-closed 测试；不恢复随机哨兵                                                                      |
| 单一循环抽取引入新 bug                            | Phase 7 只做 call 行为等价，可单独 revert                                                                          |
| compose 截断错误破坏父 frames                     | Runtime 使用不透明 FrameSegmentScope；所有异常路径做基线回滚与属性测试                                             |
| compose fold 读取或修改 live frames               | 只传冻结 segment 快照，fold 完成前禁止暴露可变数组                                                                 |
| compose 共享 scratch 造成跨边界副作用             | 这是 compose 的显式语义；需要 call/delegate 时由开发者选择更强边界                                                 |
| child Graph.goal/mechanisms 污染父 Instance       | 放入 CallFrame 局部有效配置，退出时恢复，不改写父持久字段                                                          |
| 只在活动图期间过滤，返回后内部消息泄漏            | 使用持久的 GraphCallScope start/end 区段清洗；测试外层下一轮 provider request                                      |
| command/tool 实现再次分叉                         | Registry 两个入口只能调用同一 GraphInvoker，禁止直接持有 executeGraph 闭包                                         |
| graph tool 在同一 streaming session 内重入死锁    | command/tool 默认 delegate，使用独立`IsolatedSessionGraphHost`                                                   |
| 子 AgentSession 无法获得业务工具实现              | 由业务 extension 提供 host/tool factory；对子 host 重新执行工具存在性校验                                          |
| 子会话加载当前 extension 导致 graph tool 递归注册 | child adapter 使用 runtime-only 模式，不注册 invocation/command/demo graphs                                        |
| 子会话资源、监听器或请求泄漏                      | tool signal 贯穿 host；`finally` abort + dispose；增加泄漏测试                                                   |
| 工具结果过大重新撑爆外层上下文                    | 对模型可见 content 设置上限；完整结果进入 details 或显式外部引用                                                   |
| 业务失败和基础设施错误混淆                        | `GraphRunResult.status` 只表达业务终态；host/runtime 异常直接 throw                                              |
| 图异常导致没有 call_end                           | `finally` 中闭合调用作用域；基础设施异常完成清理后继续抛出                                                       |
| compaction 切断 GraphCallScope start/end          | `session_compact` 重建活动调用 checkpoint；closed-scope 清洗加入跨 compaction 测试                               |
| call/delegate frames 作为 result 泄漏             | 普通返回只含 final result；frames 转移到 debug trace                                                               |
| delegate 默认关闭 compaction 导致长图溢出         | host compaction 改为显式配置，默认遵循 pi 并复用 NodeScope checkpoint                                              |

pi 最低版本要求：0.80.3（提供 `session_compact`、`createAgentSession`、in-memory `SessionManager` 等能力）。

---

## 七、后续

重构完成后，以下工作获得可靠基础：

- session 续跑（帧持久化 + 恢复 NodeScope）
- 多 agent 通讯（`docs/设计/communication-design.md`）
- ReAct 透传（`rawSections` 随 NodeScope 自然可用）
- 图工具成为真正的函数式能力单元：外层 agent 只负责选择图、准备 input、消费最终 result
