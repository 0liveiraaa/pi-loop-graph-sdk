# Loop Graph SDK 实现形态

> 2026-07-13 | 全阶段完成
>
> 重构计划 Phase 0-12、Mechanism Runtime Phase 0-8、模型上下文定制 Phase 0-6 全部落地。282 项测试全通过（14 文件，含真实 LLM spike）。以下为当前实现形态的完整快照。

## 重构完成状态（Phase 0-12）

- `ContextFrame` 已开放为任意开发者字段；`nodeId/status/summary/result` 仅为可选兼容字段，默认 formatter 原样稳定序列化 frame，不再替开发者挑选字段。
- END 边可通过 `MigrationResult.output` 显式声明图返回，使业务返回与模型工作记忆解耦；旧 `frame.status/result` 继续兼容。
- pi 原生 `compactionSummary` 与 recent messages 是压缩历史的权威替代。SDK 不再在压缩后重发 NodeScope 并遮挡 summary。
- Runtime 通过 `branchEntries + firstKeptEntryId + NodeScope` 计算完整落入压缩前缀的 frame 基线；共享 `call/compose` 活跃期间仍禁止 compaction。
- 图执行返回统一为 `GraphRunResult`；runtime-only 子 adapter 复用真实 `createLoopGraphExtension`。
- `GraphRuntime` 使用结构化 `NodeScopeDescriptor`（graphRunId / instanceId / scopeId / graphId / nodeId / visit / depth），主路径已删除随机 `loop_graph_boundary` 哨兵。
- projection 从尾部匹配当前 `scopeId`，输出 frames + 当前 NodeScope 后的 live ReAct；scope 缺失时 fail closed。
- Phase 7-8：root/call 收敛到单一 `runGraphLoop`；`compose` 使用 `FrameSegmentScope` 强制归约。
- Phase 9：GraphCallScope start/end 配对清洗，嵌套 call/compose 活跃期间取消 compaction。
- **Phase 10**：delegate host 已接线。`DelegateGraphInvoker` + `IsolatedSessionGraphHost` 提供隔离执行载体；`GraphRegistry` 和 `runGraphLoop` 通过 `delegateInvoker.invoke()` 调用。默认 `createDelegateHost` 未配置时抛明确错误，不静默降级。
- **Phase 11**：完整验证矩阵通过（206 项测试，含真实 LLM spike）。
- **Phase 12**：兼容层保留——`GraphNode.boundary` 可选缺省 `call`；`ContextFrame`/`Edge.guard`/`Edge.migrate`/`frameFormatter` 签名不变；`executeGraph()` 保留为高级低层 API。
- **Phase 13（内测加固 Phase 0-1）**：冻结 CURRENT/skill/retry/dead/incomplete/completion tool 默认行为；新增 root/child/agent timeout limits；同 extension instance 的并发 root `executeGraph()` 在覆盖活动状态前 fail-fast。
- **Phase 14（模型上下文定制 Phase 2）**：新增 Extension 级 `contextRenderer`。node-enter 时加载 skill 并冻结 renderer 结果；正常 scope、scope missing 与 compaction recovery 共用同一载荷；renderer 不接管 GraphCallScope/NodeScope/compaction/frame baseline。`null` 仍保留空 NodeScope 锚点。
- **Phase 15（上下文定制 Phase 4-5）**：`outputSchema` 接入 Runtime completion retry；Node validator 和 agent-choice 形成稳定校验链；恢复/失败/completion result 文案可定制。`node.skill` 支持异步 provider、自定义 renderer、missing/error 策略，并传播到 runtime-only delegate session。
- **Phase 16（上下文定制 Phase 3）**：新增 renderer registry 与直接调用 override，覆盖顺序固定为调用级 > Node > Graph > Extension > 默认。调用级 renderer 沿共享 Session 的 call/compose 传播；delegate Session 使用自身 factory 配置。renderer 抛错时图失败且不回退默认 CURRENT。
- **Phase 17（Mechanism Runtime Phase 0-1）**：每个 mechanism 的每次 node visit 获得独立 scope，提供 `signal/isActive/onCleanup`；正常、异常、call、compose 和 runtime-only delegate 路径统一关闭，cleanup 按 LIFO 执行且错误不覆盖主结果。安全 `appendContext` 绑定当前 `scopeId`，失效后返回 false；完整 `ctx.pi` 继续作为非托管能力保留。
- **Phase 18（Mechanism Runtime Phase 3 核心）**：新增 `onNodeExit/onNodeError` 和 `continue/fail-node/fail-graph`。exit hook 在 Router/Edge 前读取冻结 completion；error hook 覆盖 enter/execute/exit/router/migrate 异常且不替换主错误。多个 Hook 失败按 `fail-graph > fail-node > continue` 归并；fail-node 由 Runtime 生成可信 failed completion 并继续走 Router。
- **Phase 19（Mechanism Runtime Phase 2 — Event Broker）**：Extension 级 `MechanismEventBroker`；tool_result、turn_start、turn_end 各注册单一底层 pi listener；`ctx.events` 提供 `onToolResult/onTurnStart/onTurnEnd` 返回幂等 `dispose()`；NodeScope 关闭时自动 dispose 全部订阅；事件快照被复制并冻结；handler 按 mechanism 组合顺序串行执行；循环访问不增加底层 listener 数量；call/compose 只向当前 scope 分发，返回后恢复父订阅；handler 失败已接入 `failurePolicy`，在 Runtime 安全检查点消费，不直接从 pi callback 随机抛出。
- **Phase 20（Mechanism Runtime Phase 4 — 机制私有 State）**：`Mechanism<TState>` 泛型；`createState(): TState`；`ctx.state`；双层 `WeakMap` 以 `AgentInstance + mechanism 对象身份` 为键；同一实例同一 mechanism 跨 visit 复用 state；同名但不同对象隔离；call 创建新 state；compose 复用 state；runtime-only delegate 新 AgentInstance 创建新 state；state 不写入 `instance.scratch`，不进入模型上下文；`createState` 每实例每定义只执行一次；`createState` 失败进入 `failurePolicy` 并跳过依赖该 state 的 Hook；`instance.scratch` 继续保留为兼容共享命名空间。
- **Phase 21（Mechanism Runtime Phase 5 — Agent/Turn/Tool 观察 Hook）**：`PiNodeContext.runAgent()` 与 Mechanism broker 建立 run lifecycle；每次调用获得独立 `agentRunId`；新增 `beforeAgentRun/onTurnStart/onTurnEnd/onToolStart/onToolResult`；同节点多次 run 不串线；正式 Hook 读取冻结快照；工具结果按字节预算截断并标记 `truncated`。
- **Phase 22（Mechanism Runtime Phase 6 — 工具决策与受控 Exec）**：`beforeToolCall` 支持 allow/deny/patch，按 mechanism 顺序串行组合；每次 patch 使用工具 schema 重验，无 schema 或非法 schema 时禁止 patch；`__graph_complete__` 固定 ABI 不允许一般 patch；`afterToolResult` 只能替换模型可见 content/isError，不开放 details/toolCallId；`ctx.exec.run()` 自动绑定 scope signal、timeout、cwd 根目录与 stdout/stderr 截断；`ctx.decisions.list()` 返回决策 trace。
- **Phase 23（Mechanism Runtime Phase 7 — 异步 Completion Gate）**：outputSchema/request/node validator 支持 async；Mechanism `validateCompletion` 支持 allow/reject/fail-node/fail-graph；agent-choice 在 mechanism gate 后执行；reject 触发下一 turn；重复 completion 去重；并发 agent_end 串行；validator/gate timeout；scope signal 取消；只对 ok completion 验收；可信输出保存在 `completion.verifiedResult.checks`，AI result 无法覆盖。
- **Phase 24（Mechanism Runtime Phase 8 — 结构化 Context）**：`ctx.context.append()` 支持 string 与 text/image blocks；`appendContext` 作为兼容别名保留；SDK 固定 `loop_graph_mechanism`、display、scope details 和非 triggerTurn options；内容复制冻结并剥离额外控制字段；投影在正常、scope missing 与 compaction recovery 中按 scopeId 过滤，防止跨节点泄漏。
- **Phase 25（模型上下文定制 Phase 6 — 可观测性与外围扩展）**：`logger/traceSink` 可注入且观测错误与控制流隔离；graph start/end/error、node enter/exit、compaction 产生冻结 lifecycle event；文件输出默认关闭，`debug:true` 才启用 JSONL；graph invocation/global `formatToolResult` 可定制模型可见文本但 details 保留稳定结果；`toolResolver` 同时接入注册/存在性校验和运行时激活，SDK 始终恢复 read/`__graph_complete__` 安全边界。
- 事件 handler 的 failurePolicy 接线已通过 Phase 19（Event Broker）完成，不再等待。
- 验证：`npm test -- --run` 通过（14 文件、**265 项**，包含真实 LLM spike）；`tsc --noEmit` 与 `git diff --check` 通过。

> 下文部分历史章节仍记录 MVP 演进背景；当前实现以本节为准。

---

## 一、文件结构

```
src/
├── type.ts                 # 核心类型（Graph, Node, Edge, Router, AgentInstance, Mechanism, …）
├── runtime.ts              # GraphRuntime（调用栈 callStack + 帧栈 frames + NodeScope）
├── validate.ts             # 图校验 + 工具校验（validateGraphTools）
├── router.ts               # 单边裁决
├── tools-resolve.ts        # ★ 工具解析单一真相源（resolveNodeTools：去重 + 排序）
├── agent-execute.ts        # createAgentExecute 工厂（tools 参数已废弃）
├── registry.ts             # GraphRegistry 实例级图注册表（+ deprecated 全局兼容层）
├── index.ts                # 对外导出（library API + deprecated 兼容层）
├── adapter/
│   ├── mechanism-runtime.ts     # ★ MechanismInvocationGroup + MechanismEventBroker + mechanism state 管理
│   ├── loop-graph-extension.ts  # ★ 可实例化运行时工厂 createLoopGraphExtension()
│   ├── extension.ts             # debug/demo extension 入口（可选，{ demoGraphs: true }）
│   ├── projection.ts            # 纯函数：scope 匹配 + frames 格式化
│   ├── projection.test.ts       # 投影测试（19 条）
│   ├── pi-node-context.ts       # Promise 桥接：runAgent + after_provider_response 错误回流
│   ├── complete-tool.ts         # __graph_complete__ 工具定义
│   ├── debug-log.ts             # 旧内部调试 facade；文件输出需 PI_LOOP_GRAPH_DEBUG=1
│   ├── observability.ts         # logger/traceSink、生命周期事件与显式 JSONL sink
│   ├── compaction-frame.test.ts # Compaction 边界 / frame 行为 / fail-closed 测试
│   ├── loop-graph-extension.test.ts  # 工厂 + 实例隔离 + 子图 agent + 工具校验 + Mechanism 生命周期/state/事件/~35 条
│   ├── characterization.test.ts # NodeScope 行为冻结基准（NodeScope visit/唯一性/时序/fail-closed）
│   ├── graph-execution-host.ts       # DelegateGraphInvoker / IsolatedSessionGraphHost
│   ├── graph-execution-host.test.ts  # Host 生命周期测试
│   ├── graph-execution-host.spike.test.ts  # 独立 AgentSession 可行性验证
│   ├── isolated-graph-session.ts     # In-memory 隔离 session 工厂
│   ├── isolated-graph-session.test.ts # 隔离 session 集成测试
├── graphs/
│   ├── review-graph.ts     # echo 测试图
│   ├── probe-graph.ts      # NodeScope 可见性验证图
│   ├── chain-graph.ts      # 双节点链式验证图
│   ├── subgraph-graph.ts   # 子图隔离验证图
│   └── validate-graph.ts   # 完成度验证测试图
├── tools-resolve.test.ts   # ★ resolveNodeTools 单元测试（14 条）
├── registry.test.ts        # GraphRegistry parseArgs + 闭包绑定测试
├── runtime.test.ts         # GraphRuntime 单元测试
├── router.test.ts          # 路由策略单元测试
├── validate.test.ts        # 图校验 + 工具校验单元测试（15 条）
└── docs-consistency.test.ts # 文档一致性检查
```

---

## 二、核心机制

### 2.1 NodeScope 作用域消息

**目的**：标记当前活动节点的开始位置，为 projection 提供可靠的语义化锚点。

**实现**：

- 每次进入需要调用 agent 的节点时，追加一条 `customType: "loop_graph_node_scope"` 消息
- `content` 包含 CURRENT 段信息，是 agent 真正需要看到的上下文
- `details` 包含结构化 `NodeScopeDescriptor`（protocol、graphRunId、instanceId、scopeId、graphId、nodeId、visit、depth），用于投影层可靠匹配，不发送给 LLM
- 同一节点重复进入（循环边）使用不同的 scopeId 和递增 visit
- 纯代码节点（不调用 agent）可以不写入 pi transcript，减少隐藏消息积累

### 2.2 context 投影（作用域匹配）

**目的**：每次 LLM 调用前重组消息，使 agent 只看到帧栈摘要（COMPLETED）+ 当前节点工作区（CURRENT + live ReAct）。

**算法**：

```
const scopeIdx = findLastMatchingScope(messages, activeScope);

if (scopeIdx >= 0) {
  return [
    formatFrames(frames),           // COMPLETED 段
    ...messages.slice(scopeIdx),   // 当前 NodeScope 后的所有消息
  ];
}
```

**fail-closed 策略**：找不到 scope 时不回退完整 transcript，而是：

1. 输出 frames（COMPLETED 段）
2. 从当前 Node 重建确定性 CURRENT
3. 记录结构化诊断到 debug log
4. 必要时终止当前节点并明确报错

不再保留旧哨兵机制的「全部消息作为 head」降级路径。

### 2.3 帧栈折叠

`Edge.migrate` 将 `NodeCompletion` 折叠为 `ContextFrame` 推入 `AgentInstance.frames`。同一 Completion 走不同边可产生不同 frame（"边是完整决策"）。当前节点 ReAct 在迁移后不再进入后续节点上下文。

### 2.4 compose 帧段归约

对于 `boundary: "compose"` 的子图，Runtime 使用不透明的 `FrameSegmentScope` 管理临时帧段：

```
父 frames: [A, B]
               └─ baseIndex = 2
compose 执行: [A, B, C, D, E]    ← 子图帧在父栈上生长
退出并 fold:  [A, B] + graph-node completion  ← 强制截断
                         │
                         └─ 再由父 Edge.migrate 生成一个父级 ContextFrame
```

- `beginFrameSegment` 记录基线
- `closeFrameSegment` 调用 fold 后截断
- `rollbackFrameSegment` 在异常时回滚
- fold 接收冻结的帧段快照，不能修改 live frames

### 2.5 call / compose / delegate 三种图调用边界

| 边界             | AgentSession | AgentInstance | 可见内容                                     | 返回处理                                 |
| ---------------- | ------------ | ------------- | -------------------------------------------- | ---------------------------------------- |
| `call`（默认） | 复用         | 新建          | 仅 background；`frames=[]`、新 scratch     | 仅 final status/result                   |
| `compose`      | 复用         | 复用          | 父 background、父已完成 frames、共享 scratch | 子图帧段强制折叠为 graph node completion |
| `delegate`     | 新建         | 新建          | 仅 background；物理消息历史隔离              | 仅`GraphRunResult`                     |

现有 `kind: "graph"` 缺省为 `call`，保持当前行为。`delegate` 通过 `DelegateGraphInvoker` 创建独立 `IsolatedSessionGraphHost` 执行；未配置 `createDelegateHost` 时抛明确错误，不静默降级。

### 2.6 GraphCallScope（共享 session 调用审计）

`call` 和 `compose` 在开始/结束时写入配对的消息：

```
// 图开始
{ customType: "loop_graph_call_start", details: { protocol, graphRunId, boundary, ... } }

// 图结束
{ customType: "loop_graph_call_end", details: { protocol, graphRunId, status } }
```

context 处理拆为两步：

1. `stripClosedGraphCalls(messages)` — 始终清除已闭合调用区段
2. `projectActiveNodeScope(messages, runtime)` — 有活动图时执行

### 2.7 compaction 协同

- 监听 `session_compact` / `session_before_compact`，记录 `compactionGeneration`
- **root-only 图**：推进 frame 投影基线，不重发 NodeScope，不遮挡原生 summary 与 recent messages
- **嵌套 call/compose 共享 session 活跃期间**：`session_before_compact` 返回 `{ cancel: true }`，防止 pi 基于原始 transcript 生成的混合 summary 穿透调用边界
- 若取消策略因竞态异常失效，Runtime fail-closed：终止当前共享调用，过滤已污染的 compactionSummary
- SDK 不生成 LLM summary，不主动调用 `ctx.compact()`

### 2.8 完成度验证

节点可声明 `validateCompletion`，agent 调用 `__graph_complete__` 时检查 result：

```
agent → __graph_complete__({ status: "ok", result: { question: "...", answer: "..." } })
  ↓ validateCompletion: 检查必填字段
  ↓ 不通过 → inject "验证未通过: 缺少..." → triggerTurn → agent 继续
  ↓ agent 补全 → 再次 __graph_complete__
  ↓ 通过 → resolve Promise → 进入下一节点
```

### 2.9 createAgentExecute 工厂

```typescript
const myNode: Node = {
  kind: "code",
  id: "grade",
  subGoal: "批改答案",
  execute: createAgentExecute({ skill: "review-grade" }),
  validateCompletion: requireFields(["score", "explanation"]),
};
```

**注意**：`tools` 参数已废弃。工具集统一由 `Node.tools` 声明，经 `resolveNodeTools` 合并 `defaultTools` 并去重。

### 2.10 Promise 桥接 + 错误回流（runAgent）

**实现**（`pi-node-context.ts`）：

1. `runAgent()` 创建 Promise，存 `resolve` 到 `this.activeResolve`
2. `pi.sendMessage(prompt, { triggerTurn: true })` 触发 agent 运行
3. `agent_end` → `onAgentEnd()` → 检查验证 → resolve
4. 超时保护：5 分钟自动 resolve 为 `status: "failed"`
5. **Provider 错误回流**：构造函数单一监听 `after_provider_response`，`status >= 400 && !== 429` 时立即 resolve 为 `failed`（不等待超时，不误杀限流）
6. **死图防御**：`activeRunId === 0` 时 `onAgentEnd` 追加终止消息，不再静默丢弃

### 2.11 可实例化运行时工厂（★ 核心）

每个 `createLoopGraphExtension(pi, options?)` 返回独立 `LoopGraphExtension`：

```typescript
export function createLoopGraphExtension(pi, options?) {
  let activeRuntime = null;    // 实例级，不再模块全局
  let activeNodeContext = null;
  const defaultTools = options.defaultTools ?? [];
  const skillBasePath = options.skillBasePath ?? path.join(process.cwd(), "skills");
  const registry = new GraphRegistry(pi, executeGraph);
  
  return {
    registerGraph: (graph) => registry.registerGraph(graph, defaultTools),
    executeGraph: (graph, trigger) => executeGraph(pi, graph, trigger),
  };
}
```

**关键变更**：

- `activeRuntime`/`activeNodeContext` 从模块级单例 → 工厂闭包内的实例变量
- 子图执行时切换 `activeRuntime`/`activeNodeContext`（push/pop 模式）
- `GraphRegistry` 为实例级 class，业务 extension 间不互相污染
- `__graph_complete__` 用 `WeakSet` 去重，同 pi 多实例不重复注册
- `LoopGraphExtensionOptions` 新增 `skillBasePath`、`defaultTools` 参数

### 2.12 工具解析单一真相源

全仓库只有 `resolveNodeTools(defaultTools, nodeTools)` 产出最终工具列表。`setActiveTools` 调它，debug 日志也调它（通过 `pi.getActiveTools()` 读真值）。

**契约**：

- 去重（保留首次出现位置）
- `read` 强制首位
- `__graph_complete__` 强制末位
- 顺序稳定，相同输入总产出相同结果

### 2.13 注册期 + 首次执行工具校验

- **注册期**（`GraphRegistry.registerGraph`）：节点内 `tools` 数组重复名 → 立即抛错（`DUPLICATE_TOOL_IN_NODE`）
- **首次执行**（`executeGraph`）：遍历 `defaultTools ∪ node.tools`，用 `pi.getAllTools()` 检查未注册工具 → 抛错（`TOOL_NOT_REGISTERED`），缓存 per-graph

### 2.14 skill 原生集成

- `resources_discover` 事件注册 `skillBasePath`，pi 原生 skill 系统发现 SKILL.md
- 进入节点时（哨兵之后），读取 `{skillBasePath}/{node.skill}/SKILL.md` 内容，通过 `sendMessage({ display: false })` 追加到消息流（不触发额外 turn）
- 文件不存在时日志警告但不阻塞
- `skill:` 行在 projection CURRENT 段仅保留名称，完整内容由运行时追加
- `type.ts` 注释已诚实化

### 2.15 图异常终止信号回流

`executeGraph` catch 块捕获异常时，通过 `sendUserMessage` 向 agent 注入可见的终止信号：

```
[系统] 图 "xxx" 因错误意外终止：{reason}。当前节点已失效，请停止推理。
```

### 2.16 mechanism 运行时

Runtime 在节点进入后、`execute` 之前自动分派 onNodeEnter：

```
enterNode
→ AgentInstance.mechanisms.onNodeEnter
→ CallFrame.localMechanisms.onNodeEnter
→ Node.mechanisms.onNodeEnter
→ execute
  → beforeAgentRun
  → turn/tool hooks × N
→ scope abort + LIFO cleanup
```

- `Graph.mechanisms` 在 `pushGraph` 时写入 `AgentInstance.mechanisms`，跨节点持续生效。
- compose 子图的 `Graph.mechanisms` 保存在当前 `CallFrame.localMechanisms`，退出后撤销。
- `Node.mechanisms` 只在当前节点叠加。
- 每个 mechanism 若定义了 `onNodeEnter`，串行 `await onNodeEnter(ctx)`。
- 节点主体完成后、Router/Edge 前串行执行 `onNodeExit`；任意 visit 阶段抛错时执行 `onNodeError`。
- Hook 抛错按 mechanism 的 `failurePolicy` 处理；默认 `continue` 保持旧行为。
- 每次 node visit 为每个 mechanism 创建独立 scope；正常或异常退出都会 abort 并执行 cleanup。

`MechanismContext<TState>` 提供完整非托管 pi 能力和 Runtime 托管作用通道：

| 成员                           | 用途                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.pi`                     | 全部 pi 非托管能力：注册原生事件、改工具集、发消息；副作用和清理由使用者负责                                                        |
| `ctx.instance`               | 当前 AgentInstance（可写`instance.scratch`）                                                                                          |
| `ctx.node`                   | 当前节点                                                                                                                                |
| `ctx.input`                  | 代码侧一次性入参                                                                                                                        |
| `ctx.scope`                  | 当前 visit 的 `scopeId/visit/signal/isActive/onCleanup`                                                                                |
| `ctx.events`                 | scoped 事件订阅：`onToolResult/onTurnStart/onTurnEnd`，返回幂等 `dispose()`；scope 关闭时自动取消                                     |
| `ctx.state`                  | 类型化私有 state，由 `createState()` 懒初始化，跨 visit 保留；双层 WeakMap 按 AgentInstance + mechanism 对象身份隔离                  |
| `ctx.exec`                   | 受控外部命令：绑定 scope signal、timeout、cwd 根目录与输出预算                                                                          |
| `ctx.decisions`              | 当前 scope 的工具 allow/deny/patch/result 决策 trace 只读快照                                                                          |
| `ctx.appendContext(content)` | 仅在当前 scope 活跃时追加；失效后返回 false，不触发额外 turn                                                                            |
| `ctx.context.append(content)` | 推荐的结构化追加 API；支持 string/text/image blocks，固定控制字段并绑定当前 scope                                                      |

Mechanism 定义支持泛型和私有状态：

```typescript
export interface Mechanism<TState = Record<string, unknown>> {
  name: string;
  failurePolicy?: MechanismFailurePolicy;
  createState?(): TState;                       // 当前 AgentInstance 中按 mechanism 对象身份懒初始化一次
  onNodeEnter?(ctx: MechanismContext<TState>): void | Promise<void>;
  beforeAgentRun?(ctx: MechanismAgentRunContext<TState>): void | Promise<void>;
  onTurnStart?(ctx: MechanismTurnStartContext<TState>): void | Promise<void>;
  onTurnEnd?(ctx: MechanismTurnEndContext<TState>): void | Promise<void>;
  onToolStart?(ctx: MechanismToolStartContext<TState>): void | Promise<void>;
  onToolResult?(ctx: MechanismToolResultContext<TState>): void | Promise<void>;
  beforeToolCall?(ctx: MechanismToolCallContext<TState>): ToolCallDecision | void | Promise<ToolCallDecision | void>;
  afterToolResult?(ctx: MechanismToolResultContext<TState>): ToolResultDecision | void | Promise<ToolResultDecision | void>;
  validateCompletion?(ctx: MechanismCompletionContext<TState>): CompletionDecision | Promise<CompletionDecision>;
  onNodeExit?(ctx: MechanismExitContext<TState>): void | Promise<void>;
  onNodeError?(ctx: MechanismErrorContext<TState>): void | Promise<void>;
}
```

`ctx.state` 使用双层 WeakMap：
- 以 `AgentInstance` 为第一层键，`mechanism 对象身份` 为第二层键。
- 同一实例、同一 mechanism 对象跨 visit 复用 state。
- 同名但不同对象（不同 `Graph.mechanisms` 与 `Node.mechanisms` 中的实例）隔离。
- `call` 边界创建新 AgentInstance，因此创建新 state。
- `compose` 复用父 AgentInstance，因此复用 state。
- runtime-only delegate 的新 AgentInstance 创建新 state。
- state **不写入** `instance.scratch`，**不进入**模型上下文。
- `createState` 每实例每定义只执行一次；失败后进入 `failurePolicy` 并跳过依赖该 state 的 Hook。
- `instance.scratch` 继续保留为兼容的共享命名空间。

裸 `ctx.pi.on()` 保持完全可用，但 pi 没有 off，监听器属于 Session 级非托管资源；`ctx.scope.isActive()` 可让旧回调静默，却不会移除底层监听器。推荐优先使用 `ctx.events` 获取 scope 托管的订阅生命周期。

### 2.17 agent-choice 路由

agent-choice 路由允许 agent 在 completion 中声明 `chosen_edge_id`，router 据此选择边。

```typescript
completion.result.chosen_edge_id = "to_discuss";  // agent 自主决策走哪条边
```

**设计要点**：

- **不调 LLM**：router 只是从 `completion.result` 读字段，不做任何推理（编排不推理）
- **CURRENT 段渲染**：projection 在 agent-choice 节点的 CURRENT 段追加 `availableEdges` 列表，含每条边的 `id`、`description`、`priority`、`target`
- **description 必填**：agent-choice 路由下每条边必须有非空 `description`，`validateGraph` 注册期校验（`AGENT_CHOICE_EDGE_MISSING_DESCRIPTION`）
- **驳回重试**：agent 未声明 `chosen_edge_id` 或声明了不存在的边 → 利用 `validateCompletion` 驳回机制，reason 中列出所有可选边及描述，触发 agent 重试
- **降级安全网**：`selectEdge` 在 agent-choice 下仍做 priority-first fallback（防御性，正常路径被 validator 拦截）
- **单边优化**：只有一条边匹配 guard 时直接返回，不等 agent 声明

**校验注入机制**：

`runGraphLoop` 在调用 `execNodeInGraph` 前检测路由策略，若为 agent-choice 则通过 `wrapWithAgentChoiceValidator` 将节点包装：

```typescript
// 伪代码
const effectiveNode = wrapWithAgentChoiceValidator(graph, nodeId, node);
// effectiveNode.validateCompletion 已合成 agent-choice 边选择校验
```

`createAgentChoiceValidator` 产出的校验器：

1. 先跑节点自身的 `validateCompletion`（如有）
2. 检查 `result.chosen_edge_id` 非空且匹配已知边 ID
3. 失败时 reason 列出所有可选边：`  • to_archive (priority: 10) → archive_node\n    答对，归档结果`

**Edge 扩展**：

```typescript
export interface Edge {
  // ... 原有字段 ...
  /** 边的可读描述。agent-choice 路由下必填，渲染给 agent 辅助决策。 */
  description?: string;
}
```

**ProjectionInput 扩展**：

```typescript
availableEdges?: Array<{ id: string; description: string; priority: number; target: string }>;
```

`agentChoiceField` 允许自定义字段名（默认 `"chosen_edge_id"`）。

### 2.18 隔离图执行载体（delegate host）

已完整实现面向 command、tool 和 delegate graph-node 的隔离执行载体：

| 类型/组件                       | 职责                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `GraphRunRequest`             | 统一调用协议：background + invocationKind + boundary          |
| `GraphRunResult`              | 统一返回：graphId、status、result、steps；不包含 frames/trace |
| `GraphExecutionHost`          | 图执行载体抽象接口                                            |
| `IsolatedSessionGraphHost`    | 独立子 AgentSession 生命周期外壳                              |
| `DelegateGraphInvoker`        | 入口无关的统一调用器，每次 invoke 创建一次性 host             |
| `IsolatedGraphSessionFactory` | 创建 in-memory 子会话的工厂注入点                             |

**接线方式**：

1. `createLoopGraphExtension(pi, { createDelegateHost })` 传入 host 工厂
2. 工厂内部构造 `DelegateGraphInvoker(pi, createHost)` 作为 `GraphInvoker`
3. `GraphRegistry` 持有该 invoker，command/tool 入口统一通过它执行
4. graph node `boundary: "delegate"` 在 `runGraphLoop` 中通过 `delegateInvoker.invoke()` 调用
5. 未配置 `createDelegateHost` 时抛明确错误

**生命周期保证**：同一 host 禁止并发 run；outer AbortSignal 转发到子会话；清理顺序固定为 abort → dispose；dispose 幂等；dispose 后拒绝再次运行。

---

## 三、调用栈与上下文隔离契约

### 统一 callStack

从 Phase 7 开始，同一 Session 只保留一个 `GraphRuntime` 和 `PiNodeContext`，通过 `callStack` 管理多层调用：

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

- `root` push 初始 CallFrame
- `call` push 新 Instance（frames/scratch 隔离）
- `compose` push 同一 Instance 的帧段作用域（frames 共享）
- 退出时 pop，恢复父 CallFrame、NodeScope 状态和工具集

### 顶层图

`AgentInstance` 不继承图之外的完整上下文。`background` 只有 trigger 入参。

### call 边界

子图执行时复用同一 Session/Runtime，但创建新 AgentInstance：

```
push CallFrame（新 AgentInstance）
  → child Entry / nodes 执行（独立 frames/scratch）
  → 得到 child GraphRunResult
pop CallFrame（恢复父 AgentInstance）
```

这确保了子图内的 agent 节点调用 `__graph_complete__` 时，完成信号被正确的子 `PiNodeContext` 捕获，而非父图的。

### compose 边界

子图复用父 AgentInstance，frames 在父栈上生长：

```
记录 baseIndex
push compose CallFrame（复用父 AgentInstance）
  → child Entry / nodes 执行（frames 在父栈上追加）
  → 得到 child GraphRunResult
  → 截取只读 segment 快照
  → 调用 fold（默认或自定义）
  → 强制截断到 baseIndex
pop compose CallFrame
```

### delegate 边界

delegate 通过 `DelegateGraphInvoker` 在独立 `IsolatedSessionGraphHost` 中执行，创建新 AgentSession 和 AgentInstance：

```
DelegateGraphInvoker.invoke(graph, request)
  → createHost({ pi, extensionContext, graph, request })
    → IsolatedSessionGraphHost.run(graph, request)
      → 子 AgentSession 中 runtime-only adapter 执行整张图
      → GraphRunResult
    → finally: host.dispose()
```

- 外层 host 不配置时抛明确错误，不静默降级
- 配置 `createDelegateHost` 后，command、tool 和 graph-node `boundary: "delegate"` 均通过同一 `GraphInvoker` 调用

---

## 四、已验证清单

| 验证项                                       | 方式                                                                                                                                                                                          | 结果 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 命令 handler 内 await agent turn             | `/probe`                                                                                                                                                                                    | ✅   |
| 哨兵消息进入 context 数组                    | 探针日志                                                                                                                                                                                      | ✅   |
| 哨兵跨调用唯一                               | debug log                                                                                                                                                                                     | ✅   |
| 双节点链式推进                               | `/chain`                                                                                                                                                                                    | ✅   |
| 帧栈折叠（前序 ReAct 被丢弃）                | debug log projection                                                                                                                                                                          | ✅   |
| 子图 push/pop + 隔离                         | `/sub` + debug log                                                                                                                                                                          | ✅   |
| 图校验                                       | `assertValidGraph` 编译期                                                                                                                                                                   | ✅   |
| 路由独立模块                                 | `router.ts`                                                                                                                                                                                 | ✅   |
| 完成度验证                                   | `/validate-test`                                                                                                                                                                            | ✅   |
| 日志层                                       | `loop-graph-debug.log`                                                                                                                                                                      | ✅   |
| 工厂实例隔离                                 | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| 子图 agent 节点完成                          | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| parseArgs 命令入口                           | `registry.test.ts`                                                                                                                                                                          | ✅   |
| tool execute 闭包绑定                        | `registry.test.ts`                                                                                                                                                                          | ✅   |
| demo graphs 门控                             | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| defaultTools 合并                            | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| 多实例`__graph_complete__` 幂等            | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| **resolveNodeTools 去重 + 排序/自定义 resolver** | `tools-resolve.test.ts`（15 条）                                                                                                                                                     | ✅   |
| **注册期节点内工具重复检测**           | `validate.test.ts` + `loop-graph-extension.test.ts`                                                                                                                                       | ✅   |
| **首次执行未注册工具检测**             | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| **skill 追加不触发额外 turn**          | 代码审查 +`sendMessage`（无 triggerTurn）                                                                                                                                                   | ✅   |
| **after_provider_response 错误回流**   | 代码审查（构造函数单一监听）                                                                                                                                                                  | ✅   |
| **图终止信号注入 agent**               | 代码审查（`executeGraph` catch）                                                                                                                                                            | ✅   |
| **input 不进 agent 上下文**            | projection 删 input 渲染 + 显式 prompt                                                                                                                                                        | ✅   |
| **mechanism 运行时分派 + scratch**     | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| **mechanism appendContext 追加上下文** | `loop-graph-extension.test.ts`                                                                                                                                                              | ✅   |
| **自定义帧格式 frameFormatter**        | `projection.test.ts`                                                                                                                                                                        | ✅   |
| **agent-choice 路由**                  | `router.test.ts` + `validate.test.ts` + `projection.test.ts`                                                                                                                            | ✅   |
| **Phase 0 独立 AgentSession 可行性**   | `graph-execution-host.spike.test.ts`（29 条，含真实 LLM）                                                                                                                                   | ✅   |
| **Phase 1 现有行为冻结**               | `characterization.test.ts`（11 条）                                                                                                                                                         | ✅   |
| **GraphExecutionHost 生命周期契约**    | `graph-execution-host.test.ts`（8 条）                                                                                                                                                      | ✅   |
| **Phase 2 内部作用域协议**             | `NodeScopeDescriptor` 类型 + 9 条生命周期测试                                                                                                                                               | ✅   |
| **Phase 3 NodeScope 替换哨兵**         | 主 Runtime 删除`nodeMarker`/`nextMarker()`/`loop_graph_boundary`；进入节点追加 `loop_graph_node_scope`                                                                                | ✅   |
| **Phase 4 严格作用域投影**             | 投影从尾部匹配 scopeId；scope 缺失时 fail closed；19 条 projection/characterization 测试                                                                                                      | ✅   |
| **Phase 5 compaction 协同**            | 监听`session_compact`/`session_before_compact`；root 图推进投影基线；嵌套调用取消压缩                                                                                                     | ✅   |
| **Phase 6 固化调用协议与类型边界**     | `GraphInvocationBoundary`、`GraphRunRequest`、`GraphRunResult` 移入核心类型；boundary/fold 校验                                                                                         | ✅   |
| **Phase 7 单一 runGraphLoop**          | root/call 收敛到同一执行循环；callStack push/pop；157 项全量测试通过                                                                                                                          | ✅   |
| **Phase 8 compose 帧段归约**           | `FrameSegmentScope` 管理基线/回滚/关闭；默认与自定义 fold；compose→compose/call 嵌套回归                                                                                                   | ✅   |
| **Phase 9 GraphCallScope 统一实现**    | call/compose 写入配对 start/end；`stripClosedGraphCalls` + `projectActiveNodeScope` 两层清洗；嵌套调用期间取消 compaction；异常路径保证 call_end 闭合                                     | ✅   |
| **Phase 10 delegate host 接线**        | `DelegateGraphInvoker` + `IsolatedSessionGraphHost` + Registry 接线；graph node 的 `boundary: "delegate"` 通过 `delegateInvoker.invoke()` 执行；`createDelegateHost` 选项暴露给工厂 | ✅   |
| **Phase 11 完整验证矩阵**              | 206 项全量测试通过（13 文件，含真实 LLM spike），覆盖 compaction+scope、compose 异常回滚、delegate 隔离、并发等                                                                               | ✅   |
| **Phase 12 兼容性**                    | `GraphNode.boundary` 可选缺省 `call`；`ContextFrame`/`Edge.guard`/`Edge.migrate`/`frameFormatter` 签名不变；`executeGraph()` 保留为高级低层 API；支持回滚提交拆分               | ✅   |
| **Phase 19（Mechanism Runtime Phase 2 — Event Broker）** | `MechanismEventBroker`；tool_result/turn_start/turn_end 单底层 listener；`ctx.events.onToolResult/onTurnStart/onTurnEnd` 返回幂等 `dispose()`；scope close 自动取消订阅；事件复制冻结；循环不增 listener；call/compose 作用域隔离；handler 错误接入 failurePolicy | ✅   |
| **Phase 20（Mechanism Runtime Phase 4 — 机制私有 State）** | `Mechanism<TState>` 泛型；`createState()`；`ctx.state`；双层 WeakMap 按 AgentInstance + mechanism 对象身份隔离；call 新 state / compose 复用 / delegate 新 instance 新 state；state 不写入 scratch 不进模型上下文；`createState` 失败进入 failurePolicy | ✅   |
| **Phase 21（Mechanism Runtime Phase 5 — Agent/Turn/Tool Hook）** | 独立 agentRunId；beforeAgentRun/turn/tool 观察 Hook；冻结快照；工具输出预算；多次 runAgent 不串线 | ✅   |
| **Phase 22（Mechanism Runtime Phase 6 — Tool/Exec）** | allow/deny/patch + schema 重验；受限结果替换；completion ABI 保护；受控 exec；决策 trace | ✅   |
| **Phase 23（Mechanism Runtime Phase 7 — Completion Gate）** | async validator；allow/reject/fail-node/fail-graph；可信 verifiedResult；timeout/cancel/dedupe/并发保护；ok-only gate | ✅   |
| **Phase 24（Mechanism Runtime Phase 8 — Structured Context）** | context.append text/image；固定控制字段；scope metadata；missing/compaction recovery 不跨 scope 泄漏 | ✅   |
| **Phase 25（可观测性与外围扩展）** | logger/traceSink；graph/node/compaction lifecycle；debug opt-in JSONL；graph tool formatter；tool resolver | ✅   |

---

## 五、已知缺口

| 缺口                   | 说明                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 静态 result 类型推导   | Runtime 已支持 `outputSchema` 校验，但 `NodeCompletion.result` 的 TypeScript 类型仍是 `Record<string, unknown>` |
| 失败边处理             | `selectEdge` 返回 null 时优雅结束（不 throw），可通过 edge guard 语义覆盖                                       |
| 自定义 compaction 策略 | SDK 不生成 LLM summary、不主动调用 compact；root 使用 pi 原生策略，嵌套 call/compose 期间为保证边界安全而取消压缩 |
| session 续跑           | 帧栈未持久化到磁盘                                                                                                |
| 单节点多 skill         | 当前类型为 `node.skill?: string`，一次只支持一个 skill 引用；原生资源发现不等于节点多 skill 编排                 |
| 发布说明写作           | 正式发布前需完成版本发布文档                                                                                      |

### 已关闭的缺口

| 缺口                                            | 说明                                                                                                                         | 关闭版本        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------- |
| skill 原生发现与单引用加载                      | 已通过 `resources_discover` 注册路径，并在节点进入时加载单个 `node.skill`；不代表单节点多 skill 已实现                    | v0.1.0+stage3   |
| defaultTools 流入 skill 节点                    | 证实为观测造假（debug log 未包含 defaultTools）。`resolveNodeTools` + `getActiveTools()` 真值日志已修复                  | v0.1.0+stage1   |
| `createAgentExecute(options).tools` 误导      | 已 deprecated，不消费                                                                                                        | v0.1.0+stage1   |
| `defaultTools` + `node.tools` 无去重 → 400 | `resolveNodeTools` name-based dedup + 注册期校验                                                                           | v0.1.0+stage1/2 |
| 注册期无校验                                    | `validateGraphTools` 注册期 dup 检查 + 首次执行 existence 检查                                                             | v0.1.0+stage2   |
| `agent-choice` 路由未实现                     | agent 通过`completion.result.chosen_edge_id` 声明边选择；CURRENT 段渲染 `availableEdges`；`description` 注册期必填校验 | v0.1.0+stage5   |
| COMPLETED 段硬编码 JSON 格式                    | `frameFormatter` 选项让开发者完全自定义帧折叠后的上下文内容与格式                                                          | v0.1.0+stage6   |

---

## 六、后续

- schema helper 工具函数
- Pi Review Agent `/review-turn` 验证
- 正式发布前移除 debug log 文件输出
