# Loop Graph SDK 文档

## 阅读顺序（新开发者）

```
1. 设计/CONTEXT.md                  ← 术语表，先读
2. 设计/loop-graph-sdk-design.md    ← 核心设计
3. 设计/entry-message-format.md     ← 入口消息格式
4. 设计/developer-guide.md          ← 开发者指南（怎么用）
5. 形态/implementation-status.md    ← 当前实现状态
6. 设计/communication-design.md     ← 多 agent 通讯（远期设计，可选）
```

## 目录说明

| 文件夹    | 用途                             | 适合谁                   |
| --------- | -------------------------------- | ------------------------ |
| `设计/` | 系统设计文档、术语表、开发者指南 | 所有人                   |
| `计划/` | 待实现的实施计划                 | 开发者                   |
| `形态/` | 当前已实现的代码形态报告         | 接手代码的开发者和 agent |
| `归档/` | 已过时的设计和计划               | 追溯历史时查阅           |

## 文档生命周期

```
设想 → 设计/  → 计划/  → 实施 → 形态/（当前状态报告）
  ↓                          ↓
废弃                      迭代更新
  ↓                          ↓
归档/                      新形态/
```

- **设计**：采用后进入计划；废弃后进入归档
- **计划**：实施完成后进入归档；终止后进入归档
- **形态**：被迭代后进入归档

归档格式：`归档/YYYY/MM/DD_name_type/`，含 `README.md` 说明归档原因。

## 快速链接

- 想了解怎么用 → [开发者指南](%E8%AE%BE%E8%AE%A1/developer-guide.md)
- 想看当前做到哪了 → [实现形态](%E5%BD%A2%E6%80%81/implementation-status.md)
- 想看设计理念 → [核心设计](%E8%AE%BE%E8%AE%A1/loop-graph-sdk-design.md)
- 想看术语定义 → [CONTEXT](%E8%AE%BE%E8%AE%A1/CONTEXT.md)
