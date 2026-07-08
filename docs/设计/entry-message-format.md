# 入口消息格式规范

## 格式

每次进入节点时，Runtime 向 pi 对话流注入一条消息，`customType: "loop_graph_enter_node"`，内容为两个区块：

```
=== COMPLETED ===
[{ ... }, { ... }]

=== CURRENT ===
nodeId: xxx
subGoal: xxx
input:
  key: value
tools: t1, t2
skill: xxx
completeWith: __graph_complete__({ status, result })
```

## 区块定义

### COMPLETED

JSON 数组，`instance.frames` 的序列化。每条：

```json
{
  "nodeId": "select_target",
  "status": "ok",
  "summary": "已选择 cs101 卡片模式",
  "result": { "mode": "card", "subject": "cs101" }
}
```

### CURRENT

当前节点信息，key-value 格式：

| 字段 | 来源 | 格式 |
|------|------|------|
| `nodeId` | `node.id` | 字符串 |
| `subGoal` | `node.subGoal` | 字符串 |
| `input` | `input.data` | 缩进 key-value |
| `tools` | `node.tools` | 逗号分隔，无则省略 |
| `skill` | `node.skill` | 字符串，无则省略 |
| `completeWith` | 固定 | `__graph_complete__({ status, result })` |

## 示例

进入第 3 个节点（grade），已有 2 条历史帧：

```
=== COMPLETED ===
[{"nodeId":"select_target","status":"ok","summary":"已选择 cs101 卡片模式","result":{"mode":"card","subject":"cs101"}},{"nodeId":"generate_question","status":"ok","summary":"已生成题目 #q1：时间复杂度","result":{"question_id":"q1","correct_answer":"C"}}]

=== CURRENT ===
nodeId: grade
subGoal: 判断用户答案是否正确
input:
  question_id: q1
  user_answer: A
tools: review_answer
skill: review-grade
completeWith: __graph_complete__({ status, result })
```

## frame 内容由谁决定

帧栈中的每条 frame（`summary` 和 `result`）由 Edge.migrate 函数产出。不同边对同一 completion 可产出不同 frame。框架只保证 COMPLETED 区段的内容来自 `instance.frames`，不限制其格式。

## 与 compaction 的关系

compaction 可能毁掉之前注入的入口消息。旧消息毁了就毁了——Runtime 只追加一条新的 CURRENT 消息，内容为当前节点信息。不重建 COMPLETED。
