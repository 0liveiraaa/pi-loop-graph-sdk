# Loop Graph Extension 实现形态

> 2026-07-08 | 单 agent MVP 阶段

---

## 一、文件结构

```
src/
├── type.ts                 # 核心类型（Graph, Node, Edge, Router, AgentInstance, …）
├── runtime.ts              # GraphRuntime（调用栈 + 帧栈 + 哨兵）
├── adapter/
│   ├── extension.ts        # pi 入口：context 投影 + 命令注册 + 主循环
│   ├── projection.ts       # 纯函数：三段重组消息
│   ├── pi-node-context.ts  # Promise 桥接：runAgent / callTool
│   └── complete-tool.ts    # __graph_complete__ 工具定义
├── graphs/
│   ├── review-graph.ts     # 单节点 echo 测试图
│   ├── probe-graph.ts      # 哨兵可见性验证图
│   └── chain-graph.ts      # 双节点链式验证图
└── index.ts                # 对外导出
```

---

## 二、核心机制

### 2.1 哨兵消息

**目的**：在 pi 的 messages 数组中标记"当前节点开始"的切分点，替代原先依赖 `sessionManager.getLeafId()` 的方案。

**实现**：

- `GraphRuntime.nextMarker(nodeId)` 生成唯一标记：`__node_boundary__:{nodeId}:{递增计数}`
- 进节点前通过 `pi.sendMessage({ customType: "loop_graph_boundary", content: marker, display: false })` 注入
- 同一节点重复进入（循环边）也能区分，因为计数器递增

**已验证**：`display: false` 的自定义消息出现在 `context` 事件的 `e.messages` 数组中（探针图确认）。

### 2.2 context 投影

**目的**：每次 LLM 调用时动态重组消息，使 agent 只看到帧栈摘要 + 当前节点工作区，前序节点的 ReAct 被丢弃。

**实现**（`projection.ts`，纯函数）：

```
原始 messages: [head, 哨兵, node1_ReAct, node1_tools, ...]
                 ↓ projectMessages()
投影后:         [head, === COMPLETED === JSON, === CURRENT === key-value, node1_ReAct, ...]
```

- **head**：哨兵之前的消息原样保留（系统提示 + 用户命令 + 前序节点的帧栈消息）
- **frame 段**：`instance.frames` 渲染为 `=== COMPLETED === [{nodeId, status, summary, result}, ...] === END ===`
- **current 段**：`=== CURRENT === nodeId, subGoal, input, tools, skill, completeWith === END ===`
- **active**：哨兵之后的消息（当前节点 live ReAct）原样保留
- 哨兵本身不渲染给模型（`slice(splitIdx + 1)` 跳过）

### 2.3 Promise 桥接（runAgent）

**目的**：在 pi 的事件驱动模型中，让 Runtime 能用 `async/await` 等待 agent 完成。

**实现**（`pi-node-context.ts`）：

1. `runAgent()` 被调用时创建 Promise，存 `resolve` 到 `this.activeResolve`
2. `pi.sendMessage(prompt, { triggerTurn: true })` 触发 agent 运行
3. pi 全局 `agent_end` handler → `nodeContext.onAgentEnd()` → resolve Promise
4. `onAgentEnd` 检查 `pendingCompletion`（由 `tool_result` handler 在 agent 调用 `__graph_complete__` 时填充）
5. 超时保护：5 分钟自动 resolve 为 `status: "failed"`
6. `runId` + `activeRunId` 令牌机制区分多次调用

**已验证**：命令 handler 内 `await runAgent()` 能正确等待 agent_end 返回（probe + chain 图确认）。

### 2.4 __graph_complete__ 终止工具

**目的**：agent 节点完成时调用的"上报工具"，参数直接成为 `NodeCompletion`。

**实现**（`complete-tool.ts`）：

- 工具名：`__graph_complete__`
- 参数：`{ status: "ok"|"failed"|"cancelled", result: {…} }`
- 注册为 pi tool，通过 `setActiveTools` 控制在节点内可见
- `tool_result` 钩子捕获参数 → `PiNodeContext.recordCompletion()`

### 2.5 调用栈（GraphRuntime）

**目的**：管理帧栈 + 当前节点状态 + 哨兵标记。

**实现**（`runtime.ts`）：

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

## 2.6 module级别变量

**目的**：多个extension共享runtime状态

**实现**（`extension.ts`）：

- `activeRuntime`：当前活跃的 GraphRuntime（`context` 钩子读它来投影）
- `activeNodeContext`：当前活跃的 PiNodeContext（`tool_result` / `agent_end` 钩子用它捕获 completion）

- 主循环执行前设置为局部 runtime/nodeContext
- 子图执行时切换为子 runtime/nodeContext
- 结束或异常恢复为默认

### 2.6 模块级单例

`activeRuntime` / `activeNodeContext` 两个模块级变量，被 `context`、`tool_result`、`agent_end` 钩子和 `executeGraph` 主循环共享。子图执行时切换为子 runtime/nodeContext，退出时恢复。

---

## 三、已验证

| 验证项 | 方式 | 结果 |
|--------|------|------|
| 命令 handler 内 await agent turn | `/probe` | ✅ 能返回 |
| 哨兵消息进入 context 数组 | 探针日志 | ✅ `loop_graph_boundary` 出现 |
| 双节点链式推进 | `/chain` | ✅ 两步串行，自动到 END |
| TypeScript 编译 | `tsc --noEmit` | ✅ 零错误 |

---

## 四、已实现但未在 pi 中验证

| 项目 | 说明 |
|------|------|
| 帧栈投影折叠 | 代码已实现，但 chain 测试中未显式验证节点 B 的 context 消除了节点 A 的 ReAct |
| 子图 push/pop | `runSubgraph()` + `activeRuntime` 切换已写完，未建图测试 |
| 工具 save/restore | `saveActiveTools` / `restoreActiveTools` 已实现 |

---

## 五、实现思路

### 设计原则

1. **帧栈是真相源**：`AgentInstance.frames` 存在 JS 内存。投影是"视图"，从 frames 渲染而来，compaction 毁掉视图后从 frames 重建。
2. **隔离栈**：子图创建新 AgentInstance，`frames = []`。切换 `activeRuntime` 实现自然隔离——context 钩子读的是子图视角。
3. **声明式折叠**：`Edge.migrate` 函数决定怎么折叠 completion → frame。开发者控制 summary 和 result 的内容，框架不干预。
4. **不处理 compaction**：投影天然免疫——每次 context 钩子从 frames 重渲染。compaction 毁旧消息不影响帧栈。

### 文件职责边界

| 文件 | 依赖 pi? | 可单测? |
|------|---------|--------|
| `type.ts` | 否 | ✅ |
| `runtime.ts` | 否 | ✅ |
| `projection.ts` | 否 | ✅ |
| `pi-node-context.ts` | 是 | ❌（需 mock pi） |
| `extension.ts` | 是 | ❌ |
| `complete-tool.ts` | 是 | ❌ |

---

## 六、已知缺口

| 缺口 | 说明 |
|------|------|
| ~~`validate.ts`~~ | ✅ 已实现 |
| ~~`router.ts`~~ | ✅ 已独立 |
| ~~复合节点 `kind: "graph"`~~ | ✅ 已实测 |
| `agent-choice` 路由 | `throw Error` 占位 |
| `pi-node-context.callTool` | `throw Error` 占位 |
| error handling 完整性 | 无边匹配、无路由等 throw 被 catch，但行为未详细设计 |
| `console.error` 探针 | 正式发布前需移除或改为条件日志 |

---

## 七、验证清单

| 验证项 | 状态 |
|--------|------|
| 死锁验证（单 agent turn） | ✅ |
| 双节点链式推进 | ✅ |
| 哨兵跨调用不重复 | ✅ |
| 帧栈折叠（前序 ReAct 被丢弃） | ✅ |
| 子图 push/pop | ✅ |
| 图校验 + 路由独立模块 | ✅ |
| 日志层 | ✅ |

## 八、后续

- 补隔离栈契约的类型注释
- 正式发布前移除 debug log 或不输出到文件
- `agent-choice` 路由
- `pi-node-context.callTool` 实现
