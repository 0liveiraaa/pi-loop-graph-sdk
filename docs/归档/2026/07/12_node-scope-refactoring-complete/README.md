# 归档说明

**原位置**：`docs/计划/2026-07-11_node-scope-projection-refactor.md`

**归档原因**：该重构计划已全部实施完毕（Phase 0-12），206 项测试全通过。代码已进入稳定运行阶段。

## 计划概要

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | graph tool 独立执行载体可行性闸门 | ✅ |
| 1 | 冻结现有行为（characterization tests） | ✅ |
| 2 | 引入内部作用域协议（NodeScopeDescriptor） | ✅ |
| 3 | NodeScope 替换随机哨兵 | ✅ |
| 4 | 重写 projection 为严格作用域投影 | ✅ |
| 5 | compaction 协同 | ✅ |
| 6 | 固化调用协议与类型边界 | ✅ |
| 7 | 抽取单一 runGraphLoop | ✅ |
| 8 | compose 帧段与强制归约 | ✅ |
| 9 | call/compose 统一 GraphCallScope 实现 | ✅ |
| 10 | command/tool/graph-node 统一接入 delegate host | ✅ |
| 11 | 完整验证矩阵 | ✅ |
| 12 | 兼容性、迁移与回滚提交拆分 | ✅ |

## 当前文档位置

当前实现形态详见：
- `docs/形态/implementation-status.md`
- `docs/形态/developer-guide.md`

归档日期：2026-07-12
