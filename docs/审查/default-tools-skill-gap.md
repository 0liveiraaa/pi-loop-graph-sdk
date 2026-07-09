# defaultTools 与 skill 节点工具丢失问题记录

本文记录 Loop Graph SDK 中 `defaultTools` 在 skill 模式节点上的行为差异，以及为什么它会在某些执行路径里“丢掉”。

## 现象

在 `generate_question` 这类声明了 `skill: "review-question"` 的节点中，运行时 trace 只看到基础工具和框架工具：

- `read`
- `__graph_complete__`

`defaultTools` 配置的工具没有出现在最终可见工具集里。

## 结论

这属于实现与语义承诺不一致的问题。

从 SDK 代码表面看，`defaultTools` 的语义是“节点进入时自动附加的一层默认工具”。但在 skill 模式节点里，最终执行会经过 `ctx.runAgent(...)`，再进入 pi 的 agent turn 重新装配工具集。当前实现没有把 `defaultTools` 作为最终工具集的持久来源保留下来，因此在 skill 路径上它会被覆盖或绕开。

## 当前实现链路

1. 节点进入时，SDK 会先调用 `setActiveTools([read, ...defaultTools, ...node.tools, __graph_complete__])`。
2. `createAgentExecute(...)` 将 `skill` 和 `tools` 传给 `ctx.runAgent(...)`。
3. `PiNodeContext.runAgent()` 只是发出 prompt 并触发一次 agent turn，本身并不消费这两个字段去做二次合并。
4. skill 模式进入底层 turn 后，pi 会按自己的机制重新确定这轮可用工具。
5. 由于 SDK 没有在这条路径上显式保留 `defaultTools`，最终工具集只剩基础工具和框架工具。

## 为什么会“绕过去”

根因不是 `defaultTools` 没有设置，而是它只存在于 SDK 这一层的 active tools 逻辑里。skill 节点会继续进入底层 agent turn，而底层 turn 重新装配工具时没有把 SDK 先前设置的默认工具合并回来，所以最终表现像是 defaultTools 被跳过了。

换句话说，工具集合被两层逻辑分别处理了：

- 上层 SDK 先加了一次
- 下层 skill turn 又重建了一次

后者没有继承前者的结果，于是前面的 defaultTools 看起来就“丢掉”了。

## 影响

- defaultTools 在普通节点和 skill 节点上的行为不一致。
- 开发者不能仅靠 defaultTools 依赖 skill 节点稳定获得默认工具。
- 从语义上看，SDK 对 defaultTools 的承诺与实际行为没有完全对上。

## defaultTools 与 node.tools 重复为何之前没炸

你现在这组配置里，`defaultTools`、节点自身的 `tools`，以及 `createAgentExecute({ tools })` 三处都在声明同一批工具。这个状态本身就已经是重复来源，只是**之前没有稳定触发模型侧的唯一性校验**。

更准确地说，之前“6 个工具没报错”不代表重复被正确处理了，只能说明那一版最终送到模型侧的工具组合结果还没有把这个缺陷暴露出来。加上第 7 个工具 `review_list_dir` 后，最终工具列表的组合方式发生了变化，原本潜伏的重复被 DeepSeek 的 `Tool names must be unique` 校验抓住，于是报错变得稳定可见。

因此，这里更像是：

- 代码里一直存在重复来源
- 早先只是没触发模型侧的校验
- 新增第七个工具后，把潜伏问题稳定暴露出来

所以问题不在于“第七个工具本身特殊”，而在于工具组装链路没有在 SDK 边界上保证最终工具名唯一。

## 处理建议

有两种方向：

1. 代码层修复：让 skill 模式节点的最终工具集显式合并 defaultTools。
2. 文档层澄清：如果 skill 节点本来就不应继承 defaultTools，就需要明确说明，并提供另一条正交的工具注入机制。

## 相关文件

- [src/adapter/loop-graph-extension.ts](../../src/adapter/loop-graph-extension.ts)
- [src/agent-execute.ts](../../src/agent-execute.ts)
- [src/type.ts](../../src/type.ts)
- [docs/设计/loop-graph-sdk-design.md](loop-graph-sdk-design.md)
