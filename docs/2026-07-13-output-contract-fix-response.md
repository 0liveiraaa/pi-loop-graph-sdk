# SDK 输出契约与完成反馈问题修复回复

> 日期：2026-07-13  
> 对应反馈：`SDK outputSchema 未进入 Agent 上下文与完成反馈过早`  
> SDK 状态：代码修复及 SDK 自动化测试已完成，等待业务侧真实 `/study` 路径复测

## 结论

业务侧反馈成立。问题由两个相互关联的设计缺陷造成：

1. `outputSchema` 只参与事后校验，模型首次生成前看不到完整输出要求；
2. `__graph_complete__` 在 Runtime 验收前就把模型提交表达为“节点完成”，造成成功与拒绝反馈相互矛盾。

SDK 已完成相应重构。`outputSchema` 现在正式定义为“单次 Agent Run 的输出契约”，模型提交与 Runtime 接受也已拆分为两个不同阶段。

## 修复后的行为

### 1. 模型在首次生成前看到完整输出契约

当业务调用：

```typescript
ctx.runAgent({
  prompt: "生成一道题",
  outputSchema: questionOutputSchema,
});
```

SDK 会在本次 prompt 和首个模型 turn 前注入：

```text
=== OUTPUT CONTRACT ===
提交到 __graph_complete__.result 的值必须严格符合以下 JSON Schema：
{ ...完整且稳定序列化的 schema... }
=== END OUTPUT CONTRACT ===
```

模型可以看到字段、类型、`required`、`additionalProperties` 等全部约束。业务 prompt 不再需要复制一份 schema。

模型可见文本和 Runtime validator 来自同一个规范化契约，不存在两份实现漂移的问题。每份契约还会生成稳定的 SHA-256 指纹，供日志关联。

### 2. `outputSchema` 的作用域是单次 Agent Run

契约属于一次 `ctx.runAgent()`，不是 Node 的固定契约。因此以下场景均可正确工作：

- `createAgentExecute({ outputSchema })`；
- 业务手写 `ctx.runAgent({ outputSchema })`；
- 同一 hybrid Node 连续执行多次、使用不同 schema 的 Agent Run；
- 连续多个 Agent Node；
- call、compose 和 delegate 子图。

自定义 context renderer 不能删除当前活动契约；发生 compaction 后，SDK 也会恢复仍然有效的契约。

### 3. 完成工具改为“候选提交”

模型调用：

```text
__graph_complete__({ status: "ok", result: {...} })
```

现在只表示“提交候选结果”，不代表节点已经完成。成功路径变为：

```text
模型提交候选结果
→ outputSchema 校验
→ 本次 runAgent validator
→ Node validator
→ Mechanism 验收
→ agent-choice 校验
→ Runtime 接受并生成 NodeCompletion
→ 工具反馈“节点结果已通过检查并接受”
```

拒绝路径变为：

```text
模型提交候选结果
→ 某层校验失败
→ 不生成 NodeCompletion
→ 当前工具结果立即返回具体拒绝原因
→ 模型在同一次 Agent Run 中修正并再次提交
```

校验不再等待 `agent_end`，也不再额外注入一条可能与工具结果冲突的 retry 消息。

### 4. SDK 不再重复回显模型提交参数

完成工具的模型可见结果和最终 `details` 现在只包含 Runtime 决策，例如：

```json
{
  "decision": "accepted",
  "completionStatus": "ok",
  "validation": "passed",
  "schemaFingerprint": "..."
}
```

或：

```json
{
  "decision": "rejected",
  "validatorStage": "outputSchema",
  "reason": "输出不符合 outputSchema: ...",
  "schemaFingerprint": "..."
}
```

模型原本发起的 assistant tool call 仍然包含它自己填写的参数，这是模型自身消息的一部分；SDK 消除的是对这些参数的二次复制和错误背书。

完成工具内部也不再把原始参数写入 tool result `details`。SDK 直接使用 pi 提供的 `ToolResultEvent.input` 读取本次调用参数。

### 5. UI 展示 Runtime 结论

默认 UI 的调用阶段只显示：

```text
提交节点结果
```

不会显示模型自报的 `ok` 或完整业务结果。检查完成后显示：

```text
✓ 节点结果已通过检查
```

或：

```text
✗ 节点结果未被接受：具体原因
```

模型报告 `failed` 或 `cancelled` 时允许形成相应终态，并跳过只针对成功结果的校验链。

## API 调整

本项目当前为内部 SDK，本次没有保留语义不准确的旧 formatter。

原配置：

```typescript
completionToolResultFormatter: ({ nodeId, status, result }) => string
```

替换为：

```typescript
completionFeedbackFormatter: ({ nodeId, decision }) => string
```

新 formatter 只能根据 Runtime 决策生成文案，不再接收模型原始 `status/result`。

示例：

```typescript
createLoopGraphExtension(pi, {
  completionFeedbackFormatter({ nodeId, decision }) {
    if (decision.decision === "accepted") {
      return `${nodeId} 的结果已接受`;
    }
    if (decision.decision === "rejected") {
      return `${nodeId} 的结果未接受：${decision.reason}`;
    }
    return `${nodeId} 验收失败：${decision.reason}`;
  },
});
```

`outputSchema` 的公共类型已从 `unknown` 收紧为 `JsonSchema`。schema 必须是可以稳定序列化的普通 JSON 对象。默认最大值为 64 KiB，可通过 `outputContractMaxBytes` 调整；非法或超限 schema 会在 Agent Run 启动前报错，不会被截断。

## 新增可观测性事件

`traceSink` 现在可以接收：

- `output_contract.prepared`
- `completion.submitted`
- `completion.validation_started`
- `completion.rejected`
- `completion.accepted`
- `completion.failed`

事件可通过以下字段关联一次完整执行：

- `graphRunId`
- `graphId`
- `scopeId`
- `nodeId`
- `agentRunId`
- `schemaFingerprint`
- `validatorStage`
- `durationMs`

事件默认不包含完整 schema 和业务 `result`，避免日志体积膨胀和业务数据泄漏。

## SDK 侧验证结果

SDK 已覆盖以下自动化场景：

- 非直觉字段、类型、`required` 和 `additionalProperties` 在首次 turn 前可见；
- 模型可见契约和 Runtime validator 同源；
- schema 非法或超过预算时启动前失败；
- 自定义 renderer 无法删除契约；
- 同一 Node 的多次 Agent Run 契约隔离；
- 连续两个 Node 不泄漏 schema；
- compaction 后恢复活动契约；
- 无效提交即时拒绝，不出现“节点完成: ok”；
- 被拒绝后可以再次提交，包括重新验收相同 JSON；
- call、compose、delegate 中的 Agent Run 使用同样的契约机制；
- UI 不展示模型原始提交参数；
- 完成事件不记录完整业务结果。

当前 SDK 全量测试结果：

```text
15 个测试文件通过
298 项测试通过
TypeScript 类型检查通过
构建通过
```

## 业务侧迁移与复测建议

### 需要调整

1. 更新到包含本次修复的 SDK 版本或提交；
2. 如果配置了 `completionToolResultFormatter`，迁移到 `completionFeedbackFormatter`；
3. 删除业务 prompt 中为了规避旧问题而手工复制的 schema，保留 `outputSchema` 作为唯一真相源；
4. 不再依赖旧的 `节点完成: ok` 文本判断节点是否完成，应以图结果或 Runtime decision 为准。

### 建议复测 `/study`

沿原问题中的真实路径执行：

1. 启动 `/study`；
2. 选择 `demo-review`、第 1 章、`practice`、`S-U`、`short_answer`；
3. 确认 `generate_question` 首次模型生成前已经看到完整题目输出 schema；
4. 确认首次结果合法时直接通过检查；
5. 如首次结果非法，确认工具只显示明确拒绝原因，不出现“节点已完成”的矛盾提示；
6. 确认模型修正后二次提交可以到达 `END`；
7. 确认 UI 折叠视图不展示完整题目 result；
8. 确认 trace 中可以按 `graphRunId/scopeId/agentRunId` 关联契约、提交、验证和最终决定；
9. 确认学习会话最终状态、attempt 和 summary 正常落盘。

## 当前保留的设计边界

本次没有动态替换 `__graph_complete__` 的工具 parameters。完成工具仍按 Session 注册一次，单次 Agent Run 的具体结构通过 Runtime 输出契约消息表达。

这是有意选择：当前 pi 没有正式的 per-turn 工具 schema 替换协议，动态修改全局工具定义可能在多节点、call/compose 和并发 Session 中造成 schema 泄漏。未来如果 pi 提供安全的运行级覆盖协议，可以让工具 schema 直接引用同一份 `OutputContract.schema`。

除业务侧真实 `/study` 复测外，本次反馈对应的 SDK 代码工作已经完成。
