# 设计与内部文档候选稿

本目录是任务 06 的候选交付，不是当前正式文档。旧文档归档后，可由最终收口任务将这些文件移动到正式位置。

## 候选映射

| 候选文件 | 建议正式位置 | 读者 |
| --- | --- | --- |
| `core-design.md` | `docs/design/core-design.md` | SDK 使用者与维护者 |
| `internals/context-projection.md` | `docs/internals/context-projection.md` | Runtime 维护者、高级 renderer 作者 |
| `internals/runtime-boundaries.md` | `docs/internals/runtime-boundaries.md` | Runtime 与 delegate host 维护者 |
| `internals/mechanism-runtime.md` | `docs/internals/mechanism-runtime.md` | Mechanism Runtime 维护者 |
| `research/multi-agent-communication.md` | `docs/research/multi-agent-communication.md` | 未来设计研究者 |
| `adr-review.md` | 收口时用于修订现有 ADR，不建议长期发布 | 文档维护者 |

## 使用规则

- 不要与旧 `loop-graph-sdk-design.md`、`entry-message-format.md`、`communication-design.md` 并行发布，否则会重新产生两个事实来源。
- 正式迁移前，由导航任务修正相对链接。
- 核心设计只说明当前稳定架构；实现细节只存在于 `internals/`。
- `research/` 中的内容不属于当前 SDK 能力承诺。

