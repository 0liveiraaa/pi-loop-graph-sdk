# pi-loop-graph-sdk 使用反馈

本文档来自 pi-review-agent 接入 Loop Graph SDK 过程中遇到的实际问题，供 SDK 团队参考迭代。所有结论均基于运行时 trace 和反复实验验证。

## 背景

pi-review-agent 定义了一个 `review_single_turn` graph，包含 7 个节点：

```
prepare_review_turn → show_material → generate_question → answer_question
   (code)              (tools)          (skill)              (tools)
                                                              ↓
                                                         grade_answer
                                                           (skill)
                                                              ↓
                                                         archive_turn
                                                           (tools)
                                                              ↓
                                                     choose_turn_action → END
                                                           (tools)
```

节点分为两类：

- **工具调用节点**（`show_material`、`answer_question`、`archive_turn`、`choose_turn_action`）：执行时需调用 TUI 工具与用户交互。
- **skill 模式节点**（`generate_question`、`grade_answer`）：通过 `skill: "review-question"` 加载 skill 文件，agent 自主完成推理。
- **code 节点**（`prepare_review_turn`）：同步执行，不涉及模型调用。

工具在三个地方声明（原始代码）：

1. Extension 层：`pi.registerTool({ name: "review_card", ... })`
2. Graph 全局：`createLoopGraphExtension(pi, { defaultTools: ["review_card", ...] })`
3. 节点级：`tools: ["review_card", ...]` 和 `createAgentExecute({ tools: ["review_card", ...] })`

---

## 问题 1：`defaultTools` 不流入 skill 模式节点

### 现象

`generate_question` 节点声明为 `skill: "review-question"`，没有写 `tools` 数组。运行时 trace 显示该节点只拿到两个工具：

```json
{"type":"tools_changed","nodeId":"generate_question","tools":["read","__graph_complete__"]}
```

`defaultTools` 中配置的工具没有进入该节点。

### 影响

skill 节点与工具调用节点的工具注入路径不一致。要给 skill 节点增加工具时，`defaultTools` 不起作用，只能靠节点级 `tools` 声明。

### 验证方式

运行时 `tools_changed` trace 事件。

### 期望行为

方案 A：`defaultTools` 对所有节点生效，节点级 `tools` 做增量追加。
方案 B：文档明确说明 skill 节点不受 `defaultTools` 影响，并提供正交的注入机制。

---

## 问题 2：`defaultTools` 与节点级 `tools` 组合产生重复，无去重

### 现象

原始代码中每个工具调用节点的 `tools` 数组与 `defaultTools` 存在大量重叠。例如 `showMaterial` 声明了 `tools: ["review_card", "review_exam_points", "review_chapter"]`，而 `defaultTools` 也包含这三个工具名。

在某个 SDK 版本或特定条件下（trigger：向 `defaultTools` 新增加一个工具名），SDK 将两个来源的工具名直接拼接后发给模型，不做 name-based dedup。DeepSeek API 返回：

```
Error: 400: {"message":"Tool names must be unique.","type":"invalid_request_error"}
```

该错误在**非 skill 节点（`show_material`）和 skill 节点（`generate_question`）上都出现过**，说明不是 skill 节点特有的问题，而是所有节点类型的 tools 组装路径都缺少去重。

### 已验证的解法

清空 `defaultTools: []`，各节点仅靠自身的 `tools` 数组声明所需工具。单一来源，不再有重复。

### 期望行为

**短期**：SDK 在组装最终 tools 列表时做 name-based dedup（同 name 只保留一份）。

**长期**：graph 注册阶段就检测全局 + 节点级 tools 的冲突，提前报错，不要等到模型 400。

---

## 问题 3：节点级 `tools` 是 SDK 读取工具的唯一来源，`createAgentExecute(options).tools` 不生效

### 现象

原始代码中每个工具调用节点同时在两处声明工具：

```javascript
// 节点级
const showMaterial = {
  tools: ["review_card", "review_exam_points", "review_chapter"],
  execute: createAgentExecute({
    tools: ["review_card", "review_exam_points", "review_chapter"],  // 重复声明
    prompt(input) { ... },
  }),
};
```

实验验证：**删除节点级 `tools` 但保留 `createAgentExecute(options).tools`**，agent 在节点内只拿到 `read` + `__graph_complete__`，所有 TUI 工具不可用。恢复节点级 `tools` 后工具立即恢复。证明 SDK 读的是节点级 `tools`，`createAgentExecute` 中的 `tools` 字段对工具可用性无实际作用。

### 影响

- `createAgentExecute(options).tools` 字段具有误导性——它在 API 中存在，原始代码中也填写了，但实际操作中无效。
- 开发者可能误以为修改 `createAgentExecute` 的 `tools` 就能控制工具集，实际上必须改节点级 `tools`。
- 如果 SDK 将来决定改为读取 `createAgentExecute` 的 `tools`，现有代码会出现工具"凭空消失"的问题。

### 期望行为

统一到一个来源。建议保留节点级 `tools`（graph 结构更直观），废弃 `createAgentExecute` 中的 `tools` 参数，或在文档中明确标注其作用范围。

---

## 问题 4：注册期无校验，工具名冲突只在模型 API 层暴露

### 现象

问题 2 中描述的重复工具名，SDK 在 graph 注册时不检测，只在构造 API 请求后由 DeepSeek 返回 400 才发现。开发者得到的错误信息是：

```
Error: 400: {"message":"Tool names must be unique."...}
图结束（无边匹配 show_material）
```

没有任何提示指向"defaultTools 和节点 tools 有重复"，排查完全靠猜。

### 静态分析

从代码结构上看，这个问题出在“注册”和“装配”是两条分离路径：

1. `GraphRegistry.registerGraph()` 只负责把图登记到 registry，并按 `invocation` 注册命令和工具。
2. 它检查的是 `graph.id` 是否重复，不检查 `defaultTools`、节点 `tools`、`createAgentExecute({ tools })` 的组合是否冲突。
3. 真正把工具名拼成最终可见列表的地方，不在 registry 注册阶段，而是在节点进入时的运行时装配阶段。
4. 因此，重复工具名不会在注册期被拦截，只会在后续生成模型请求时，由模型/提供方做唯一性校验后才暴露出来。

换句话说，SDK 目前缺少一个“工具名全集校验”的前置步骤。它只知道“图有没有注册过”，不知道“这张图最终会不会生成重复工具名”。

### 为什么只能在模型 API 层看到

因为唯一性约束不在本地注册层执行，而是在最终请求发给模型时才会被 DeepSeek 识别。也就是说：

- 本地 registry 不做冲突检查
- 节点运行时也不做去重/预检
- 最终只有模型 API 会拒绝重复工具名

所以报错消息会以 400 的形式出现，而且位置看起来像是“出题节点坏了”，但根因其实是“工具集合构造坏了”。

### 期望行为

graph 注册时校验：

1. 全局 `defaultTools` 与各节点 `tools` 的并集是否有 name 冲突
2. 引用的 tool name 是否都已注册（`pi.registerTool` 已调用）
3. 发现问题立即抛出可读的错误信息，指明冲突源

---

## 问题 5：模型 400 错误后 graph 终止但 agent 不知情，形成"僵尸"状态

### 现象

重复工具名导致 DeepSeek 返回 400 时，SDK 的行为是：

```
Error: 400: ...
[loop_graph_complete]
图结束（无边匹配 show_material）
```

graph 框架判定节点失败并退出。但 agent 的对话上下文**没有收到任何失败信号**——agent 继续正常推理、读取资料文件、生成题目、甚至多次尝试调用 `__graph_complete__` 提交结果。所有后续 `__graph_complete__` 调用被 graph 框架静默丢弃。

agent 在白耗 token 产出有效结果，但这些结果全部丢失。用户看到 agent 正常工作却"卡住"，不知道发生了什么。

### 静态分析

这不是单纯的“异常没抛出来”，而是**错误的归属层级不对**。

当前链路里，`runAgent()` 只是发出一轮 prompt 并等待 `agent_end`；`executeGraph()` 则在外层 try/catch 里接住运行时异常。两者都把“模型 400 / 工具冲突”当成一次图执行失败来处理，但没有把这个失败显式回传给仍在运行的 agent 上下文。

从代码行为上看会出现两个结果：

1. 图层已经判定本轮失败并退出，runtime 被 reset。
2. 但 agent 侧没有收到一条可继续推理的结构化失败信号，只是看到本轮 turn 结束或被中断。

这就是所谓“僵尸状态”的来源：**图已经结束，agent 还以为自己可以继续产出内容**。后续再调用 `__graph_complete__` 时，图层已经没有活动上下文可接收这些结果，于是这些结果被静默丢弃。

### 为什么会造成“继续推理但结果丢失”

因为当前实现只把错误记录成图层日志/消息，并没有把错误转成 agent 能理解的、可驱动下一步行为的输入。对 agent 来说，这更像是“上一轮没有成功提交”，而不是“当前图已经因为工具冲突终止”。

所以它会出现两个表面现象：

- 继续生成题目、继续读取资料、继续尝试完成节点
- 但这些结果不再进入有效图上下文，最终全部丢失

### 这类问题为什么要和问题 4 一起看

问题 4 是“错误来得太晚”；问题 5 是“错误来得太晚之后，图层没有把错误转成 agent 可感知状态”。

如果注册期就能拦截工具冲突，问题 5 这类僵尸状态通常就不会出现，因为 graph 根本不会进入后续的无效 turn。也就是说，问题 5 本质上是问题 4 的后续症状。

### 影响

- token 浪费：agent 在已终止的 graph 中继续推理
- 结果丢失：agent 生成了正确的题目和答案，但 graph 不接收
- 排查困难：根因（400 / 重复工具名）对用户和开发者完全不可见

### 期望行为

1. 节点因 API 错误失败时，框架应向 agent 注入错误信息，让 agent 知道发生了什么（而非假装一切正常）。
2. 或者，框架应在节点失败后**阻止后续 agent 推理**，不要继续把 prompt 发给 agent。
3. 更根本的：在注册期检测（问题 4）可以完全避免此类运行时错误。

---

## 总结

| # | 问题                                            | 类型     | 优先级 | 如何发现          |
| - | ----------------------------------------------- | -------- | ------ | ----------------- |
| 1 | `defaultTools` 不流入 skill 节点              | 功能缺失 | P1     | 运行时 trace      |
| 2 | `defaultTools` + 节点 `tools` 无去重 → 400 | Bug      | P0     | 模型 API 报错     |
| 3 | `createAgentExecute(options).tools` 不生效    | API 误导 | P1     | 对照实验          |
| 4 | 注册期无校验，冲突到运行时才发现                | 缺失     | P0     | 排查 400 根因过程 |
| 5 | 400 后 graph 终止但 agent 不知情（僵尸状态）    | Bug      | P0     | 运行时观察        |
