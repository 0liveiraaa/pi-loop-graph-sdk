# 任务 04：任务型使用指南

## 目标

将当前开发者指南按真实开发任务拆分。每篇回答一个“如何做”，不重复讲完整架构。

## 目标目录

创建 `docs/guides/`，至少包含：

- `build-a-loop.md`：条件路由和跨阶段循环。
- `mix-code-and-agent.md`：agent-only、code-only、hybrid。
- `call-subgraphs.md`：call/compose/delegate 的代码用法。
- `control-tools.md`：节点白名单、toolResolver、beforeToolCall/afterToolResult。
- `automatic-validation.md`：outputSchema、validator、Mechanism completion gate、verifiedResult。
- `customize-context.md`：frameFormatter、contextRenderer、skill renderer、`ctx.context.append()`。
- `mechanism-hooks.md`：scope、state、events、exec、cleanup、failurePolicy。
- `observability.md`：logger、traceSink、生命周期事件和 debug JSONL。

## 写作模板

每篇统一采用：

```text
适用场景
最小代码
运行顺序/结果
安全边界或常见错误
相关概念和 API 链接
```

## 术语解释要求

- scope 首次出现时写为“当前节点执行周期（scope）”。
- visit 仅在确有诊断需求时出现，并解释为节点进入序号。
- verifiedResult 必须说明由 Runtime 生成，和 AI 自报 result 分离。
- `ctx.pi` 必须明确为完整但非托管能力。

## 迁移来源

从 `docs/形态/developer-guide.md` 提取仍然正确的示例，但必须重新核对代码，不能机械复制。原指南中的类型总览、内部投影和完整示例不属于本任务。

## 验收

- 每篇只解决一个任务。
- 示例之间不依赖隐藏的前置代码；需要共用定义时明确链接快速开始。
- 不出现已经 deprecated 的 `runAgent.tools` 推荐写法。
- 不使用固定 frame 兼容字段作为最佳实践。

