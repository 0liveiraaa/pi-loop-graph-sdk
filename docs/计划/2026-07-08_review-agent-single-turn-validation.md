# Review Agent Single Turn Validation Plan

> 2026-07-08 | Pi Review Agent `/review-turn` 单题回路迁移验证

## 前置条件

SDK 侧已完成以下能力（Tasks 1-4）：

- [x] `package.json` 包含 `main` / `exports`，可被其它 pi package 通过包名导入
- [x] `createLoopGraphExtension(pi)` 工厂可用，不依赖 SDK 自带 debug extension 初始化
- [x] 业务包在 `dependencies` 中声明 `pi-loop-graph-sdk` 后可直接 `import`
- [x] Demo graphs 默认不注册，命令空间无污染
- [x] 文档给出两种安装方式（debug extension / library dependency）
- [x] `parseArgs` 命令入口已正确实现（`/review-turn algebra` → parsed params）
- [x] tool execute 闭包绑定正确
- [x] 子图 agent 节点 `__graph_complete__` 链路完整（activeRuntime push/pop）
- [x] 同 pi 多实例不会重复注册 `__graph_complete__`

## 验证流程

### 阶段 1：依赖接入

Pi Review Agent 侧：

1. 在 `package.json` 的 `dependencies` 中添加：
   ```json
   "pi-loop-graph-sdk": "git:github.com/0liveiraaa/pi-loop-graph-sdk#v0.1"
   ```

2. 运行业务 extension 时确认无模块找不到警告。

### 阶段 2：注册单图命令

```typescript
// extensions/review/index.ts
import { createLoopGraphExtension } from "pi-loop-graph-sdk";
import { reviewSingleTurnGraph } from "./graphs/review-single-turn";

export default function reviewExtension(pi) {
  // 保持原有 /review 不变
  // ...

  // 新增 /review-turn 并行验证
  const loop = createLoopGraphExtension(pi);
  loop.registerGraph(reviewSingleTurnGraph);
}
```

### 阶段 3：运行单题回路

图拓扑：

```
prepare_review_turn
  → show_material
  → generate_question
  → answer_question
  → grade_answer
  → archive_turn
  → choose_turn_action
  → END
```

### 阶段 4：验收标准

- [ ] `/review-turn` 启动时无模块解析警告
- [ ] 图执行到达 `archive_turn` 节点
- [ ] 帧栈在每一步正确折叠（前序节点 ReAct 不泄漏到后续节点）
- [ ] `__graph_complete__` 正常完成 → resolve → 边迁移 → 下一节点
- [ ] 如果 archive 是 agent-tool 驱动的（非代码节点直接调 `review_archive`），文档明确标注"agent-enforced, not code-enforced"
- [ ] 原有 `/review` 行为不受影响（命令空间不冲突）
- [ ] `/review-turn` 重复进入（循环边回到 `show_card` / `generate_question`）帧栈不重叠

## 已知限制（影响验证范围）

| 项 | 影响 | 文档策略 |
| --- | --- | --- |
| `callTool` 未实现 | 代码节点无法直接调 pi tool | 归档、题目渲染等 action 由 agent 节点驱动（agent-enforced） |
| `agent-choice` 未实现 | `choose_turn_action` 需用 `custom` or `first-match` | 短期用 custom router |
| 单 `skill` | 节点只能声明一个 skill | 业务包自行合并 skill 内容或在 execute 自定义 prompt |

## 下一步

验证通过后：

- `/review` 选择阶段保留现有 TUI，选择完成后可迁移到图
- `/review-init` 设计为独立子图（隔离栈），可通过 `Node.graph` 在 review 主图中复用
- `/review-fix` 同理

## 相关文档

- SDK Library Boundary Evolution Plan: `docs/计划/2026-07-08_sdk-library-boundary-evolution-plan.md`
- SDK 使用反馈: `docs/loop-graph-sdk-usage-feedback.md`
- Developer Guide: `docs/设计/developer-guide.md`
