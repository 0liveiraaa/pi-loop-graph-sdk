# Loop Graph Extension 实现形态

> 2026-07-08 | 单 agent MVP 阶段

---

## 一、文件结构

```
src/
├── type.ts                 # 核心类型（Graph, Node, Edge, Router, AgentInstance, …）
├── runtime.ts              # GraphRuntime（调用栈 + 帧栈 + 哨兵）
├── validate.ts             # 图校验
├── router.ts               # 单边裁决
├── agent-execute.ts        # createAgentExecute 工厂
├── adapter/
│   ├── extension.ts        # pi 入口：context 投影 + 命令注册 + 主循环
│   ├── projection.ts       # 纯函数：三段重组消息
│   ├── pi-node-context.ts  # Promise 桥接：runAgent / callTool + 完成度验证
│   ├── complete-tool.ts    # __graph_complete__ 工具定义
│   └── debug-log.ts        # 调试日志
├── graphs/
│   ├── review-graph.ts     # echo 测试图
│   ├── probe-graph.ts      # 哨兵可见性验证图
│   ├── chain-graph.ts      # 双节点链式验证图
│   ├── subgraph-graph.ts   # 子图隔离验证图
│   └── validate-graph.ts   # 完成度验证测试图
└── index.ts                # 对外导出
```

---

## 二、核心机制

### 2.1 哨兵消息

**目的**：在 pi 的 messages 数组中标记"当前节点开始"的切分点。

**实现**：

- `GraphRuntime.nextMarker(nodeId)` 生成唯一标记：`__node_boundary__:{nodeId}:{递增计数}:{随机8字符}`
- 随机后缀保证跨调用不重复
- 进节点前通过 `pi.sendMessage({ customType: "loop_graph_boundary", content: marker, display: false })` 注入
- 同一节点重复进入（循环边）也能区分

### 2.2 context 投影（三段重组）

**目的**：每次 LLM 调用前动态重组消息，使 agent 只看到帧栈摘要 + 当前节点工作区，前序节点的 ReAct 被丢弃。

**哨兵切分**：

```
messages 中的布局：
[sys, user, S1, 节点A的ReAct..., S2, 节点B的prompt, 节点B的工作...]

投影找两个位置：
  firstIdx = 第一个哨兵（S1）                  ← 图的 entry 边界
  currentIdx = 当前节点的哨兵（S2 / nodeMarker）← 当前节点的起点
```

**三段产出**：

```
head = before firstIdx                          → [sys, user]（图之外的信息）
active = after currentIdx                       → [prompt, 节点B的工作...]
S1 ~ S2 之间的原始 ReAct 被丢弃，由帧段替换
```

**投影输出结构**：

```
--- head ---
[sys 系统提示]
[user /chain hello]

--- frame 段 ---
=== COMPLETED ===
[{"nodeId":"echo_a","status":"ok","summary":"节点A完成","result":{...}}]
=== END ===

--- current 段 ---
=== CURRENT ===
nodeId: echo_b
subGoal: 收到节点 A 的输出...
input:
  from_a: ...
completeWith: __graph_complete__(...)
=== END ===

--- active ---
(当前节点的 live ReAct)
```

**head 仅包含图之外的信息**（系统提示 + 用户原始命令）。已完成节点的原始 ReAct 不在投影中——被帧段替换。

### 2.3 完成度验证

节点可声明 `validateCompletion`，agent 调用 `__graph_complete__` 时检查 result：

```
agent → __graph_complete__({ status: "ok", result: { question: "...", answer: "..." } })
  ↓ validateCompletion: 检查必填字段
  ↓ 不通过 → inject "验证未通过: 缺少..." → triggerTurn → agent 继续
  ↓ agent 补全 → 再次 __graph_complete__
  ↓ 通过 → resolve Promise → 进入下一节点
```

### 2.4 createAgentExecute 工厂

替代 `execute: null as any` + `skill: "__probe__"`：

```typescript
const myNode: Node = {
  kind: "code",
  id: "grade",
  subGoal: "批改答案",
  execute: createAgentExecute({ skill: "review-grade", tools: ["review_answer"] }),
  validateCompletion: requireFields(["score", "explanation"]),
};
```

`execNode` 对所有 code 节点一律调 `node.execute()`，不再用 `skill`/`tools` 做启发式判断。

### 2.5 Promise 桥接（runAgent）

**实现**（`pi-node-context.ts`）：

1. `runAgent()` 创建 Promise，存 `resolve` 到 `this.activeResolve`
2. `pi.sendMessage(prompt, { triggerTurn: true })` 触发 agent 运行
3. `agent_end` → `onAgentEnd()` → 检查验证 → resolve
4. 超时保护：5 分钟自动 resolve 为 `status: "failed"`

### 2.6 调用栈（GraphRuntime）

```
GraphRuntime
  callStack: [{ instance, graph, currentNodeId }]  // 子图 push/pop
  isNodeActive: boolean                             // context 钩子判断是否投影
  nodeMarker: string | null                         // 当前哨兵标记
  currentNode / currentInput                        // 供投影使用
  nextMarker(nodeId) → string                       // 生成唯一哨兵
  enterNode / exitNode                              // 节点边界
  pushGraph / popGraph                              // 子图边界
```

### 2.7 模块级单例

`activeRuntime` / `activeNodeContext` 两个模块级变量，被 `context`、`tool_result`、`agent_end` 钩子和 `executeGraph` 主循环共享。子图执行时切换为子 runtime/nodeContext，退出时恢复。

---

## 三、上下文隔离契约

### 顶层图

```
用户输入 /chain hello
  ↓
executeGraph 创建 AgentInstance：
  background: { args: "hello" }    ← 只含 trigger 入参
  frames: []                       ← 从零开始
  globalGoal: "验证双节点链式推进"
```

LLM 看投影后的消息：
```
head: [sys, user /chain hello]       ← 图之外的消息（保留）
=== COMPLETED ===                    ← 帧摘要
=== CURRENT ===
active: [当前节点的工作]
```

`AgentInstance` 不继承图之外的完整上下文。`background` 只有 trigger 入参。head 段让 LLM 能看到图之外的原始消息。

### 子图

```
execNode 检测到 kind: "graph"
  ↓
runSubgraph 创建 childRuntime：
  childInstance:
    background: parent.NodeInput.data    ← 只传调用点的输入
    frames: []                            ← 隔离栈，从零开始
    globalGoal: 子图的目标
  activeRuntime = childRt                ← 投影切到子图视角
```

**子图投影**：
```
head: [sys, user /sub]            ← 图之外的原始消息（继承）
=== COMPLETED ===                  ← 子图自身的帧（空的或子图帧）
=== CURRENT ===                     ← 子图当前节点
active: ...
```

**父图的帧栈对子图不可见。** 父图执行历史不在 `head` 中——head 只到第一个哨兵（图的 entry 边界）。

---

## 四、已验证清单

| 验证项 | 方式 | 结果 |
|--------|------|------|
| 命令 handler 内 await agent turn | `/probe` | ✅ |
| 哨兵消息进入 context 数组 | 探针日志 | ✅ |
| 哨兵跨调用唯一 | debug log | ✅ |
| 双节点链式推进 | `/chain` | ✅ |
| 帧栈折叠（前序 ReAct 被丢弃） | debug log projection | ✅ |
| 子图 push/pop + 隔离 | `/sub` + debug log | ✅ |
| 图校验 | `assertValidGraph` 编译期 | ✅ |
| 路由独立模块 | `router.ts` | ✅ |
| 完成度验证 | `/validate-test` | ✅ |
| 日志层 | `loop-graph-debug.log` | ✅ |

---

## 五、已知缺口

| 缺口 | 说明 |
|------|------|
| `agent-choice` 路由 | `throw Error` 占位 |
| `pi-node-context.callTool` | `throw Error` 占位 |
| 失败边处理 | `selectEdge` 返回 null 时优雅结束（不 throw），可通过 edge guard 语义覆盖 |
| 帧栈太长触发 compaction | 不处理（投影天然免疫，框架不干预） |
| session 续跑 | 帧栈未持久化到磁盘 |

---

## 六、后续

- `agent-choice` 路由实现
- `pi-node-context.callTool` 实现
- 正式发布前移除 debug log 或不输出到文件
