---
status: superseded
superseded_by: "Phase 4 — ContextState with { select, render } projection; renderer registry replaced by per-Graph/Node context config"
---

# 固定上下文安全边界，只开放模型可见载荷 renderer

Loop Graph 允许业务自定义模型在节点内看到的 CURRENT、skill 和完成说明，但不允许 renderer 接管完整消息数组。NodeScope 匹配、已闭合 GraphCallScope 清洗、scope 缺失时 fail-closed、pi compaction summary 保留和 frame projection baseline 仍由 SDK 固定执行。

Extension 级 `contextRenderer` 在 node-enter 时同步执行一次。SDK 先读取当前单个 skill，再从 Graph、Node、NodeInput 和当前可见 frames 构造不共享 Runtime 引用的只读快照，连同 agent-choice 边和固定 completion ABI 交给 renderer。renderer 明确返回 `anchor` 与可选 `additional`，SDK 再复制并冻结全部文本块。结果被转换为一个带结构化 `details` 的 NodeScope 锚点及零到多个隐藏 CustomMessage；正常投影读取 session 中的锚点，scope 或 compaction 恢复路径复用冻结结果，不重新执行业务 renderer。

renderer 返回 `null` 时仍写入正文为空的 NodeScope 锚点。这样开发者可以不向模型展示任何 SDK 合成文字，但投影仍能证明当前消息归属；scope 缺失时仍丢弃无法证明归属的原 transcript。

已完成 frame 的主投影继续由 `frameFormatter` 负责。原因是 compaction 可以在同一节点运行期间推进 frame baseline；如果 renderer 在 node-enter 时把全部 frames 永久编码进冻结正文，压缩后会重复暴露已被 summary 替代的历史。renderer input 中的 frames 仅是 node-enter 快照，适合决定 CURRENT 表现或提供业务提示，不替代 SDK 的动态 frame baseline。

renderer 分层通过 adapter 配置承载，不向核心 Graph/Node 类型引入 adapter 依赖。`contextRenderers.graphs[graphId]` 和 `contextRenderers.nodes[graphId][nodeId]` 分别声明 Graph/Node renderer；低层 `executeGraph(..., { contextRenderer })` 提供调用级 override。优先级固定为调用级 > Node > Graph > Extension > 兼容默认实现。调用级 override 沿同 Session 的 call/compose 传播；delegate 是独立 AgentSession，只使用其 factory 自身配置，避免把函数隐式跨物理边界传递。
