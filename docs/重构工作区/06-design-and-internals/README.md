# 任务 06：压缩设计并隔离内部实现

## 目标

把“当前设计”“维护者内部协议”“历史演进”“未来研究”分开，删除重复和已经漂移的叙述。

## 修改范围

- 重写或大幅压缩 `docs/设计/loop-graph-sdk-design.md`。
- 将 `entry-message-format.md` 移到 `docs/internals/context-projection.md`，按当前 renderer/frame/compaction 行为重写。
- 将 `communication-design.md` 移到 `docs/research/multi-agent-communication.md`，顶部标明尚未实现。
- 审查 `docs/adr/`，只修正链接和明显事实漂移，不重写已接受决策。

## 核心设计文档推荐结构

```text
问题与定位
核心心智模型
一次图执行的生命周期
上下文与状态边界
子图调用边界
Mechanism 的权限边界
不可破坏的设计原则
ADR 索引
```

控制在约 150–250 行。大型 card_practice 示例移到 guides/examples；“修订 1–13”、已完成里程碑和能力债路线图移入归档或 changelog。

## Internals 应保留

- NodeScope 如何可靠标识当前节点消息。
- GraphCallScope 如何清理共享 Session 的嵌套图 transcript。
- compaction baseline 与 fail-closed 恢复。
- compose frame segment 的关闭和回滚。
- Mechanism broker 为什么使用单底层 listener。

这些内容必须明确标注为维护者/高级扩展作者阅读，不进入快速开始路径。

## 研究文档要求

多 Agent 通讯文档第一屏必须写明：

- 当前未实现。
- 不属于 0.1.x 能力承诺。
- 文中的接口和数据结构均为研究提案。

删除它对当前 AgentInstance/Node 类型的伪代码覆盖，避免与真实公共类型竞争。

## 验收

- 核心设计不再包含实施时间线。
- 当前设计与 future research 在目录层级上可直接区分。
- entry message 文档承认 CURRENT/frame 均可定制，不再宣称固定兼容字段。
- ADR 成为“为什么这样设计”的主要来源。

