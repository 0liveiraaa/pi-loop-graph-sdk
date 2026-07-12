# Loop Graph SDK 文档

## 阅读顺序（新开发者）

```
1. 设计/CONTEXT.md                  ← 术语表，先读
2. 设计/loop-graph-sdk-design.md    ← 核心设计
3. 设计/entry-message-format.md     ← 入口消息格式
4. 形态/developer-guide.md          ← 开发者指南（怎么用）
5. 形态/implementation-status.md    ← 当前实现状态
6. 设计/communication-design.md     ← 多 agent 通讯（远期设计，可选）
```

## 目录说明

| 文件夹    | 用途                             | 适合谁                   |
| --------- | -------------------------------- | ------------------------ |
| `设计/` | 系统设计文档、术语表、开发者指南 | 所有人                   |
| `计划/` | 当前待实施计划；完成或终止后移入 `归档/` | 维护者和实施者 |
| `形态/` | 当前已实现的代码形态报告         | 接手代码的开发者和 agent |
| `归档/` | 已过时的设计和计划               | 追溯历史时查阅           |

## 文档生命周期

```
设想 → 设计/  → 实施 → 形态/（当前状态报告）
  ↓                    ↓
废弃                迭代更新
  ↓                    ↓
归档/                新形态/
```

- **设计**：采用后进入计划；废弃后进入归档
- **计划**：实施完成后进入归档；终止后进入归档
- **形态**：被迭代后进入归档

归档格式：`归档/YYYY/MM/DD_name_type/`，含 `README.md` 说明归档原因。

## 快速链接

- 想了解怎么用 → [开发者指南](%E5%BD%A2%E6%80%81/developer-guide.md)
- 想看当前做到哪了 → [实现形态](%E5%BD%A2%E6%80%81/implementation-status.md)
- 想看设计理念 → [核心设计](%E8%AE%BE%E8%AE%A1/loop-graph-sdk-design.md)
- 想看术语定义 → [CONTEXT](%E8%AE%BE%E8%AE%A1/CONTEXT.md)
- 当前实现形态 → [开发者指南](%E5%BD%A2%E6%80%81/developer-guide.md) 和 [实现形态报告](%E5%BD%A2%E6%80%81/implementation-status.md)
- 架构决策 → [ADR-0001：图调用边界](adr/0001-graph-invocation-boundaries.md)
- 上下文渲染边界 → [ADR-0002：固定安全边界，只开放模型载荷](adr/0002-scope-safe-context-renderer.md)
- 完成校验与 skill 内容 → [ADR-0003：固定 completion ABI，开放业务校验与 skill 来源](adr/0003-completion-validation-and-skill-content.md)
- 当前计划 → [模型上下文定制与内测加固实施计划](%E8%AE%A1%E5%88%92/2026-07-12_model-context-customization-plan.md)
- Mechanism 改造计划 → [作用域化 Mechanism 与 Agent Hook Runtime 实施计划](%E8%AE%A1%E5%88%92/2026-07-12_scoped-mechanism-runtime-plan.md)
- 已完成的计划 → [节点作用域投影与图调用隔离重构（已归档）](%E5%BD%92%E6%A1%A3/2026/07/12_node-scope-refactoring-complete/2026-07-11_node-scope-projection-refactor.md)
