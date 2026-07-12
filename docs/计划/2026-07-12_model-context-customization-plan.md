# 模型上下文定制与内测加固实施计划

> 状态：proposed  
> 日期：2026-07-12  
> 范围：单 Agent Loop Graph SDK；不扩展多 Agent 通讯或 session 恢复

## 实施进度

- Phase 0：已完成（2026-07-12）——冻结模型可见默认消息，修正文档中的多 skill/已实现能力漂移。
- Phase 1：已完成（2026-07-12）——limits 配置、参数校验、同 instance root run fail-fast 并发保护。
- Phase 2：已完成（2026-07-12）——Extension 级 scope-safe renderer、输入输出无别名快照、node-enter 冻结、null 锚点、recovery 复用和 delegate 传播验证。
- Phase 3：已完成（2026-07-12）——调用级 > Node > Graph > Extension > 默认覆盖；call/compose 传播，delegate 保持独立配置。
- Phase 4：已完成（2026-07-12）——outputSchema 校验链、恢复消息 formatter、completion tool result formatter。
- Phase 5：已完成（2026-07-12）——异步 skill provider、skill renderer、缺失/错误策略和 delegate 传播。
- Phase 6：待实施。

## 一、结论

原建议的主判断基本成立：`ContextFrame` 已可完全自定义，但 SDK 生成的 CURRENT、skill、completion/retry 和错误恢复消息仍包含固定格式，因此尚不能宣称“整个模型可见上下文高度可定制”。

不过建议中有三项已经被当前代码关闭，不能继续列为待办：

- 共享 `call/compose` 在异常收到 `session_compact` 时已经 fail-closed；
- agent-choice 已实现并具备 completion 校验；
- debug logger 已将业务 frame 当作 opaque payload，控制字段来自 `NodeCompletion`/Runtime。

内测前真正需要完成的 P0 是：

1. 增加受 Runtime 安全边界约束的模型上下文 renderer；
2. 为同一 extension instance 的直接并发执行提供明确保护；
3. 将 root/child step 上限和 agent run timeout 配置化；
4. 为上述行为补齐回归测试和开发者文档。

`AgentRunRequest.outputSchema` 未接线属于已声明未兑现的 API，应作为紧随 P0 的 P1 完成。

## 二、核对依据

### 2.1 当前确实固定发送给模型的内容

| 内容 | 当前位置 | 结论 |
| --- | --- | --- |
| `=== COMPLETED ===` 默认包装 | `src/adapter/projection.ts` | 已可通过 `frameFormatter` 整体替换 |
| CURRENT 中的 `nodeId/subGoal/tools/skill` | `buildNodeInfoContent()` | 不可定制，核心缺口 |
| agent-choice 的 edge id/priority/target | `buildNodeInfoContent()` | 可满足协议，但默认暴露控制面过多 |
| `completeWith: __graph_complete__...` | `buildNodeInfoContent()` | 协议本身应固定，表现应可定制 |
| `[skill: name]` 和完整 SKILL.md | `appendSkillContent()` | loader 与表现均固定 |
| validation retry / dead run / incomplete reason | `PiNodeContext` | 模型可见恢复策略固定 |
| completion tool result 文本 | `complete-tool.ts` | 固定，但影响较低 |
| graph error/dead 消息 | `loop-graph-extension.ts`、`PiNodeContext` | UI 与模型消息混在同一实现中 |

### 2.2 已实现、无需重复建设

| 原建议 | 当前证据 | 处理 |
| --- | --- | --- |
| 补共享调用 compaction fail-closed | `session_before_compact` 取消；异常 `session_compact` 设置边界违规并清空后续模型投影 | 从计划删除 |
| 实现 agent-choice | router、validator、CURRENT edge choices 和测试均已存在 | 从计划删除 |
| debug frame 改为 opaque | `debugLog.exitNode()` 使用 `framePreview`，状态来自 completion | 从计划删除 |
| delegate 并发隔离 | 每次 invocation 创建独立 host；同一 host 拒绝并发 | 保持现状 |

### 2.3 pi 侧约束

根据当前安装的 pi 开发指南和类型：

- `context` 事件允许修改发送给 LLM 的 messages，适合承载投影内核；
- CustomMessage 的 `details` 不发送给 LLM，适合继续保存 NodeScope 控制元数据；
- `session_before_compact` 可以取消压缩，`firstKeptEntryId` 是保留区边界；
- `sendMessage(..., { triggerTurn: false })` 可以追加上下文而不启动额外 turn；
- tool definition 在 extension 注册期注册，不适合按节点动态替换 `__graph_complete__` schema。

因此 `outputSchema` 应先接入 Runtime completion 校验，而不是动态改写全局 completion tool 的 parameters。

## 三、设计决策

### 3.1 固定投影内核，开放模型载荷 renderer

renderer 不得接管完整 `context` messages，也不得自行处理 NodeScope、GraphCallScope 或 compaction。固定内核继续负责：

- 删除已闭合 GraphCallScope；
- 按 `scopeId` 匹配当前 NodeScope；
- scope 缺失时 fail-closed；
- 保留 pi compaction summary 与 recent messages；
- 按 Runtime 的 frame projection baseline 选择 frames。

renderer 只接收内核已计算好的业务语义输入，并产出 SDK 合成的模型可见消息。建议契约：

```typescript
export interface NodeContextRenderInput {
  graph: GraphContextView;
  node: NodeContextView;
  input: NodeInputView;
  frames: readonly ContextFrame[];
  availableEdges: readonly EdgeChoice[];
  skill: { ref: string; content: string } | null;
  completion: {
    toolName: "__graph_complete__";
    statuses: readonly ["ok", "failed", "cancelled"];
  };
  reason: "node-enter";
}

export interface RenderedContextMessage {
  content: string | readonly TextContent[];
  kind?: "current" | "completed" | "skill" | "instruction";
}

export type NodeContextRenderer =
  (input: NodeContextRenderInput) => {
    anchor: RenderedContextMessage | null;
    additional?: readonly RenderedContextMessage[];
  } | null;
```

Runtime 在 node-enter 时解析 skill，并把 Graph/Node/Input/frame 转换为不共享引用的只读快照后执行 renderer。返回的 anchor 与 additional 内容同样被复制、冻结到当前 NodeScope 状态中。projection 只复用这份结果；compaction/scope 恢复不得重新执行任意业务 renderer，以保证确定性。

兼容 renderer 复现当前 COMPLETED/CURRENT/skill 格式。现有 `frameFormatter` 保留，作为兼容 renderer 的一个局部覆盖点，不立即移除。

### 3.2 renderer 覆盖优先级

原建议的 “Graph > Node” 不符合就近覆盖原则，修正为：

```text
调用点 renderer
> Node renderer
> Graph renderer
> Extension 默认 renderer
> SDK 兼容 renderer
```

第一阶段只必须实现 Extension 级 renderer。Node/Graph/调用点覆盖在类型形态确认后增加，避免一次性扩大核心类型和调用协议。

### 3.3 Completion Protocol 保持 ABI，开放校验与表现

以下内容保持固定：

- 工具名 `__graph_complete__`；
- `ok/failed/cancelled` 三种最低控制状态；
- Runtime 捕获 completion 和节点退出的规则。

第一阶段开放：

- completion instruction 的渲染；
- tool result 文本格式；
- validation retry / incomplete / dead-run 模型消息格式；
- `outputSchema` 的 Runtime 校验。

暂不允许每图或每节点改 completion tool 名称。当前一个 pi Session 可以存在多个 SDK 实例，而 completion tool 只注册一次；动态名称或 schema 会引入注册冲突和活动节点串线风险。

### 3.4 Skill 扩展分为 provider 与 renderer

建议使用更精确的名称：

```typescript
type SkillContentProvider =
  (ref: string, context: SkillLoadContext) => Promise<string | null>;

type SkillContentRenderer =
  (ref: string, content: string, context: SkillRenderContext) => RenderedContextMessage | null;
```

默认 provider 保持 `skillBasePath/{ref}/SKILL.md`。renderer 决定是否显示 skill 名称及如何包裹正文。pi 的 `resources_discover` 仍只负责原生 skill 发现；节点声明 skill 时是否保证加载完整正文，由 Loop Graph 的 provider 契约负责。

### 3.5 并发语义

当前 command/tool 默认走独立 delegate host，已经具备跨 host 并发隔离。风险集中在公开的低层 `executeGraph()`：同一 extension instance 使用单槽 `activeRuntime/activeNodeContext`，并发调用会覆盖状态。

MVP 不引入同 Session 多运行调度器，采用 fail-fast：

- 同一 extension instance 已有 root run 活跃时，再次调用 `executeGraph()` 立即抛出明确错误；
- 错误提示要求创建独立 AgentSession/delegate host；同一 pi Session 上的另一个 extension instance 不视为并发隔离；
- 保持嵌套 `call/compose` 使用同一 Runtime callStack，不被误判为并发；
- 增加交错 Promise 测试，证明第二个 root run 在修改活动状态前被拒绝。

## 四、实施阶段

### Phase 0：行为冻结与文档基线

目标：防止在重构 renderer 时破坏投影安全不变量。

- 为默认 CURRENT、skill、retry、dead/incomplete、completion tool result 增加 characterization tests；
- 为 scope missing、compaction recovery、closed GraphCallScope 增加 renderer 前后的等价断言；
- 修正文档中“多 skill 已关闭”等互相矛盾的表述；当前类型仍是 `node.skill?: string`，应明确为单 skill 引用；
- 将 206 项测试和 typecheck 作为改造基线。

验收：默认配置下模型可见消息与当前版本兼容，全部现有测试通过。

### Phase 1：运行策略与同实例并发保护（P0）

新增：

```typescript
interface LoopGraphLimits {
  rootMaxSteps?: number;       // default 100
  childMaxSteps?: number;      // default 50
  agentRunTimeoutMs?: number;  // default 300_000
}
```

- `LoopGraphExtensionOptions.limits` 注入 root/child loop；
- timeout 从 `PiNodeContext` 构造参数注入；
- 校验值必须为有限正整数；
- `executeGraph()` 增加 root-run busy guard，并保证 finally 释放；
- delegate host 的现有并发语义不变。

验收：默认值行为不变；自定义值生效；零值、负值、NaN 被拒绝；同实例第二个 root run fail-fast。

### Phase 2：安全受限的 Context Renderer（P0）

- 新增 renderer 类型与 Extension 级 `contextRenderer`；
- 提取默认兼容 renderer；
- node-enter 时加载 skill、计算并冻结 rendered context；
- NodeScope `details` 继续只保存控制元数据，不把 renderer 结果放入 details；
- projection 内核只拼接 summary、frames、scope anchor、rendered messages 和 live ReAct；
- scope/compaction 恢复复用冻结结果；
- `frameFormatter` 通过兼容适配层继续工作；
- renderer 返回 `null` 时仍必须保留不可见的作用域锚点语义，且不得回退原 transcript。

验收：开发者能隐藏 nodeId、tool、skill、edge target/priority 和 SDK 标签；NodeScope/GraphCallScope/compaction 测试全部保持通过。

### Phase 3：Node/Graph/调用点覆盖层（P1）

- 在不破坏纯核心类型的前提下选择配置承载位置；
- 实现 `call-site > Node > Graph > Extension > compatibility`；
- 对 renderer 抛错定义 fail-closed：图失败，不回退到未经确认的完整 transcript；
- 明确 renderer 是同步纯函数，异步 IO 必须放在 provider 阶段。

验收：同一 SDK 实例的不同图、不同节点可以采用不同上下文风格，覆盖优先级有单元测试。

### Phase 4：Completion schema 与模型消息格式（P1）

- 将 `AgentRunRequest.outputSchema` 接到 completion result 的 Runtime 校验；
- 优先复用项目已依赖的 TypeBox 校验能力，失败走现有 retry 回路；
- 合并 `outputSchema`、node `validateCompletion` 和 agent-choice validator，定义稳定顺序：schema → node validator → agent-choice；
- 增加类型化 `modelMessageFormatter`：validationRetry、incompleteNode、deadRun、graphFailure；
- completion tool result 允许格式化文本，但 `details` 保留原 completion 参数。

验收：schema 不合法时不会退出节点；三类 validator 的顺序和错误消息稳定；默认中文文案兼容。

### Phase 5：Skill provider/renderer（P1）

- 默认 provider 复现当前文件系统读取；
- 支持异步 provider、缺失策略和错误策略；
- skill renderer 可隐藏 ref、重排 frontmatter/正文或返回 null；
- provider 结果按 node-enter 生命周期缓存，不在每轮 context hook 重读；
- 保留 `resources_discover`，但文档明确“发现”与“节点强制加载”是两条职责链。

验收：文件、数据库/远程 mock、自定义格式、缺失 skill 均有测试；不会额外触发 agent turn。

### Phase 6：可观测性与外围扩展（P2）

- 注入 `logger`/`traceSink`，默认关闭文件输出或仅在 debug 模式开启；
- 生命周期事件：graph start/end/error、node enter/exit、compaction；
- graph tool `formatToolResult`；
- tool resolver 策略扩展。

这些能力不阻断受控内测，不与 renderer P0 混在同一变更中。

## 五、明确不做

- 不允许替换 NodeScope 身份与匹配规则；
- 不允许 renderer 访问或返回完整原始 transcript；
- 不允许 renderer 绕过 closed GraphCallScope 清洗；
- 不允许修改 compose 帧段关闭/回滚规则；
- 不允许更改 compaction `firstKeptEntryId` 边界判断；
- 不在本计划中实现 session 重启恢复、多 Agent 通讯或同 Session 并行 root graph；
- 不把 `Mechanism` 复用为监控/审计总线。

## 六、发布与验收门槛

### 受控内测门槛

- Phase 0、1、2 完成；
- 默认兼容行为、renderer 自定义行为、并发拒绝、limits 均有自动化测试；
- 全量测试、typecheck、文档一致性测试通过；
- 开发者指南明确：顺序单 Agent、delegate 并发、无 session 恢复、单 skill 引用、completion ABI 固定。

### “上下文高度可定制”声明门槛

- 至少完成 Phase 2、4、5；
- 业务可隐藏全部 SDK 展示标签和控制面标识；
- retry、completion、skill 正文均可定制；
- 投影安全不变量仍由 SDK 固定控制。

### stable/通用 SDK 门槛

不由本计划单独满足。至少还需要 session 恢复策略、正式 trace API、发布兼容策略和更长期真实 compaction/故障注入验证。

## 七、建议提交拆分

1. `test: freeze model-visible context and concurrency gaps`
2. `feat: configure graph execution limits and reject concurrent root runs`
3. `feat: add scope-safe node context renderer with compatibility adapter`
4. `feat: add renderer precedence for node graph and call site`
5. `feat: validate completion outputSchema and format recovery messages`
6. `feat: add skill content provider and renderer`
7. `docs: update developer guide and implementation status`

每个行为提交都必须同步更新 `docs/形态/implementation-status.md`；Phase 2 的固定投影内核/开放载荷 renderer 属于难以逆转且有真实取舍的架构决策，实施时应补一份 ADR。
