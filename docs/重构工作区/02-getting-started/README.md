# 任务 02：十分钟快速开始

## 目标

创建一篇线性教程，让没有项目背景的开发者完成安装、定义图、注册图和运行图。教程只讲完成任务所需的最少概念。

## 目标文件

- 新增 `docs/getting-started.md`。
- 不修改根 README；README 任务会链接到本文。

## 教程路线

1. 前置条件：Node.js、pi extension 环境、TypeScript。
2. 安装依赖。
3. 创建 extension 入口并调用 `createLoopGraphExtension(pi)`。
4. 创建一个 agent 节点或 `createAgentExecute()` 节点。
5. 创建 Entry、END Edge 和 Graph。
6. 注册 Graph。
7. 展示命令调用或直接 `executeGraph()` 的一种方式。
8. 添加第二个节点和一条条件边，解释循环图的价值。
9. 链接到 Mechanism、自动验收和子图指南。

## 教学语言

- Graph：整个任务流程。
- Node：一个工作阶段。
- Completion：阶段结果。
- Edge：决定接下来去哪，并保存哪些工作记忆。
- 第一次出现 frame 时称为“留给后续阶段的工作记忆”。

不要在主教程解释 NodeScope、GraphCallScope、AgentInstance 内部结构、compaction 或 broker。

## 代码要求

- 使用当前公共 API。
- `inputSchema` 必须是有效 object schema。
- 每个节点返回的 `nodeId` 与节点定义一致。
- END 边显式返回 `MigrationResult.output`，避免依赖兼容字段。
- 展示 `Node.tools` 是节点工具白名单，而不是 `runAgent.tools`。

## 验收

- 完整代码可以放入一个最小 extension 中运行。
- 教程从安装到第一次运行不超过十个主要步骤。
- 没有“参见源码才能理解”的跳跃。
- 文末给出下一步阅读路径，而不是继续堆叠高级能力。

