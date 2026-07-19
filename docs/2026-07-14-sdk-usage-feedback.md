# pi-loop-graph-sdk 使用反馈

> 日期：2026-07-14  
> 使用方：Pi Study Helper  
> SDK commit：`d9106b9ae6f717cdb348cf743d0ab7f13ebad1aa`  
> 总体评价：当前线性业务闭环可稳定开发，使用体验约为 7/10；没有阻塞里程碑一的问题，但仍有若干需要产品层自行封装的能力。

## 实际使用范围

本反馈不是基于示例图，而是来自以下真实产品链路：

```text
生成题目
→ 语义判题
→ 题目讨论
→ 会话总结
→ 更新学习画像
→ 从 Markdown/txt 提取 Profile 语义片段
```

当前证据：

- 6 张业务图在真实 Pi 和真实模型中全部到达 `END`。
- 6 次带 `outputSchema` 的 Agent Run 均形成被 Runtime 接受的候选结果。
- 学习会话、逐题记录、总结和 Profile 构建片段均有磁盘或 trace 结果。
- Pi Study Helper 自动测试 99/99、TypeScript 类型检查、extension smoke 和文档链接检查均通过。
- SDK 已用于真实 TUI 命令，而不只是 SDK 自带命令或测试环境。

## 使用顺手的部分

### 1. 图执行主链路已经稳定

`executeGraph()`、代码节点、Agent Run、Edge、router 和 `END` 能够组成可靠的线性闭环。业务代码可以根据 `GraphRunResult.status` 明确决定继续、回退或标记会话中断。

### 2. 输出契约修复后体验明显改善

`outputSchema` 现在会在首次模型 turn 前自动进入上下文，模型可见契约与 Runtime validator 来自同一份声明。候选提交、校验拒绝和最终接受的语义也已经分离。

这使业务层不再需要把 schema 再复制进 prompt，并且能够通过 trace 关联：

- `output_contract.prepared`
- `completion.submitted`
- `completion.validation_started`
- `completion.rejected`
- `completion.accepted`

### 3. 隔离 Session 的底层组件可用

`createIsolatedGraphSessionFactory` 和 `IsolatedSessionGraphHost` 能让 Agent 图在独立的 in-memory Session 中运行。Pi Study Helper 已使用它们隔离内部推理、工具反馈和图完成通知，用户主 TUI 只消费结构化结果。

### 4. trace 对真实问题定位有价值

JSONL trace 可以证明节点是否进入、候选是否提交、在哪一层被拒绝以及图最终状态。此前输出契约问题能够被准确定位，trace 是重要原因。

## 遇到的问题、当前解决方式与改进建议

| 问题 | 产品影响 | 当前解决方式 | 状态 | 希望 SDK 改进 |
| --- | --- | --- | --- | --- |
| npm 包入口指向 TypeScript 源码，真实 Pi/Jiti 加载时错误解析 `typebox/schema` | extension 无法启动 | SDK 改为发布 `dist` JavaScript/声明文件；消费方固定 Git commit，并加入真实 Pi smoke | 已修复 | 保留 `npm pack` 临时 consumer 和真实 Pi 加载回归测试 |
| `outputSchema` 最初只做事后校验，模型首次生成前不可见；完成工具又过早报告成功 | Agent 猜字段、反复重试，真实出题图失败 | SDK 在首次 turn 前注入同源输出契约，并把候选提交与 Runtime 接受分开 | 已修复 | 保留多节点、compaction、自定义 renderer 和拒绝后重提的回归测试 |
| 直接在用户主 Session 执行图会暴露内部 Agent 文本和 SDK 反馈 | 用户作答前可能看到答案、解析或内部执行过程 | 产品自行实现 `createIsolatedGraphExecutor()`，为每次 graph call 创建并释放独立 host | 已绕行 | 提供更高层的 `executeIsolatedGraph()` 或 command executor，自动继承 cwd、模型、认证、signal、trace 和 limits |
| `NodeContext.callTool()` 在公共接口中存在，但 Pi 实现直接抛错 | 代码节点看似能调用工具，实际运行才发现不可用 | 代码节点直接依赖 repository/领域服务；如需暴露给 Agent，pi tool 只复用相同底层实现 | 受 Pi API 限制 | 在 Pi 没有稳定 extension-side tool API 时，将能力明确标为 unavailable/optional，提供 capability check；不要让类型签名暗示一定可用 |
| 未完成图不能跨进程恢复 | 长资料构建中断后无法继续原 graph run | 产品把源资料分批，并自行保存 job、hash、fragment 和 `nextBatchIndex` checkpoint | 已绕行 | 提供正式 checkpoint/resume 扩展点，或给出官方“业务 checkpoint + 幂等批次”的推荐接口和示例 |
| Agent 结束但没有提交 completion 时，业务只能收到整图 failed | 可选讨论失败会中断学习，用户难以理解原因 | 产品对可选讨论在新隔离 Session 中重试一次，仍失败则降级返回当前题目 | 已绕行 | `GraphRunResult` 提供稳定的结构化失败类别，例如 timeout、agent-ended-without-completion、validation-exhausted、cancelled、runtime-error |
| 单节点图仍需手写 entry、finish edge、routing 等重复结构 | 六张简单 Agent 图存在较多模板代码 | 产品定义 `singleNodeEntry()`、`finishEdge()` 等本地 helper | 可用但繁琐 | 增加 `defineSingleAgentGraph()`、`defineLinearGraph()` 一类 builder，同时保留底层 Graph API |
| trace 能定位生命周期，但成本信息不完整 | 无法准确回答一次业务动作产生多少模型 turn、HTTP 请求、token 和费用 | 产品目前只统计 Agent Run、候选提交和图状态 | 尚未解决 | 增加 agent/model run 起止、provider/model、token usage、模型重试次数和耗时事件；默认仍不记录业务正文 |
| 同一 `LoopGraphExtension` 实例不支持并发 root `executeGraph()` | 将来并发构建或后台任务需要额外 host | 当前产品所有主流程串行；独立任务使用独立 delegate host | 已知边界，当前不阻塞 | 继续明确报错即可；若将来支持并发，应以独立 Session/host 隔离为前提，不共享活动 NodeContext |
| 不支持并行分支、多 Agent 通讯和图内持久恢复 | 无法直接表达复杂协作工作流 | 当前产品使用单线图和代码控制器，不把这些能力写成已支持 | 当前不需要 | 低于隔离执行、失败分类和可观测性的优先级，建议不要为本项目提前扩大核心复杂度 |

## 关键 workaround 说明

### 隔离执行

产品当前需要自行完成以下装配：

```text
从 ExtensionCommandContext 读取 cwd/model/modelRegistry/signal
→ 创建 IsolatedGraphSessionFactory
→ 为每次图调用创建 IsolatedSessionGraphHost
→ 以 delegate boundary 运行
→ finally dispose host
```

这些底层能力已经存在，但对普通业务 extension 来说仍偏底层。建议 SDK 提供一个不暴露 Agent 内部消息的高层安全默认值。

### 代码节点业务能力

`callTool()` 不可用并不妨碍确定性业务能力。当前采用：

```text
领域服务 / repository
├── 代码节点直接调用
└── pi tool adapter 调用同一底层实现（仅在 Agent 也需要时）
```

这种方式能保证持久化、路径校验、归档等关键动作不依赖模型是否主动调用工具。即使未来实现 `callTool()`，也不建议让 pi tool 成为代码节点访问业务能力的唯一入口。

### 产品级 checkpoint

Profile 构建没有尝试序列化正在运行的 Graph 或 Agent Session，而是保存：

- 源文件 inventory 与 SHA-256；
- 批次列表和下一批索引；
- 每批已接受的结构化 fragment；
- draft 与 job 状态。

恢复时重新校验源文件 hash，从未完成批次创建新的图运行。这种方法已经可用，但每个业务都需要重新设计一次。

## 建议优先级

### P0：继续保持现有回归门禁

1. 编译后包入口和真实 Pi consumer smoke。
2. `outputSchema` 首次可见、同源校验、拒绝后重提和完成反馈语义。

这两项已经修复，但一旦回归会直接导致 extension 无法加载或真实业务图失败。

### P1：改善业务 extension 的日常使用体验

1. 提供高层隔离/静默图执行 API。
2. 为 `GraphRunResult` 增加稳定、可机读的失败分类。
3. 让 `callTool` 的公共能力声明与实际 Pi adapter 能力一致，至少支持 capability check。

### P2：降低重复基础设施成本

1. 提供官方 checkpoint/幂等批处理模式。
2. 增加单节点图和线性图 builder。
3. 补充 token、请求次数、模型重试和耗时可观测性。

### 暂不建议优先

- 并行分支；
- 多 Agent 通讯；
- 同一 Session 内的并发 root 图；
- 为恢复而序列化完整 Agent Session。

这些能力有价值，但当前产品更需要可靠隔离、明确失败和可观察成本。

## 总结

SDK 已经从“验证概念”进入“可以支撑真实线性产品”的阶段。当前没有阻止 Pi Study Helper 继续实现 P4/P5 的 SDK 缺口。

最明显的体验问题不是图跑不起来，而是业务方仍需自行完成隔离执行、失败归类、checkpoint 和若干图模板。若 SDK 优先把这些重复装配收敛成稳定 API，使用体验会从“可用但需要理解内部边界”提升为“业务开发者可以直接、安全地使用”。
