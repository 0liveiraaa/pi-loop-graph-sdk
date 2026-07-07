# Loop Graph SDK 设计

> 基于 CONTEXT.md 回路图抽象，经过多轮实施讨论演进至此。

## 心智模型：栈式子图编排

AgentInstance 持有一个**有序帧栈**。每进入一个节点就在栈上生长一层，离开节点时由边负责折叠栈顶层。栈只增不减，历史不可篡改。

子图调用是一等公民：Node 可引用另一个 Graph 作为其实现。子图执行采用**隔离栈**：Runtime 为子图创建新的 AgentInstance，`background` 来自调用点传入的 `NodeInput.data`，`frames = []`，父图 frames 不可见。子图 END 时整段子图执行归约为父图该 graph 节点的一次 `NodeCompletion`。顶层图调用 = 没有调用者的子图调用。

---

## 目标

利用 pi-agent 的 extension 机制封装一套贯彻设计理念的 agent 编排工具，让 pi-agent 平台下的 skill 不再只是一个操作手册，而是一个可复用、可管理、具有较高可靠性的技能单元，为复杂业务场景下搭建 agent 架构提供便利。

---

## 核心概念

### 1. Node（节点）

可运行工作阶段。节点自身声明一切所需，不感知 Edge 和 Router。

两种形态，互斥：

- **普通节点**：提供 `execute`，Runtime 直接调用
- **复合节点**：提供 `graph`（子图），Runtime 自动委托给子图执行

**职责约束**：

- 节点只负责完成子目标并产出 `NodeCompletion`（原始产出，不做折叠）
- 节点内部允许 agent 进行 ReAct
- 节点不写 summary、不折叠上下文——如何"记住"这段经历由 Edge 决定
- 节点不直接修改 agent 实例的总目标或持久身份
- 节点不应隐藏跨节点状态迁移规则

### 2. Edge（边）

状态迁移的承载者。只做三件事：guard（条件）、migrate（折叠栈顶层并生成后继输入）、to（目标）。

**设计要点**：

- `guard` 只依赖 `NodeCompletion`——Edge 不与 agent 内部状态耦合
- `migrate` 是函数，不同边对同一个 completion 可产出不同的帧和后继节点输入
- 进入目标节点所需的 tools/skill/subGoal 由目标 Node 自行声明，Edge 不负责 prepareEntry
- 边不感知 Router

### 3. Router（路由策略）

挂在每个源节点出口处，从多条满足条件的边中裁决出最终选择。

### 4. Graph（回路图）

**入口**：独立 Entry。入口判断面对的是 `trigger + background`，而不是 `NodeCompletion`。多入口通过 `Graph.entries` 表达。

**子图组合**：复合 Node 引用另一个 Graph（`Node.graph`），以隔离栈方式执行。顶层调用就是没有调用者的子图调用。

### 5. AgentInstance（agent 实例）

回路图中的活动主体，持有一个有序帧栈。

### 6. ContextFrame（栈帧）

栈中的一层。每进入一个节点就 push 一帧；离开时由 Edge.migrate 填写。

### 7. Mechanism（机制）

横切面基础设施。全局（AgentInstance）和局部（Node）双层挂载。subGoal 是特殊的"构造函数"机制——必须存在，定义节点身份，因此在 Node 上以顶层字段而非数组元素存在。

---

## 声明式 API

SDK 对外提供两层接口：

**声明层（JSON）**：用户或 agent 用声明式格式编写部分工作流——定义图的节点列表、边列表、路由配置。这一层完全可序列化，agent 可以直接生成。

**补充层（TS）**：部分节点需要自定义逻辑（代码节点的 `execute` 实现、复合节点引用的子图注册等等）

编译入口 `compileGraph(def, custom, subGraphs)` 将声明定义 + TS 补充 + 子图池编译为运行时 `Graph` 对象。

**核心价值**：工作流的编写门槛从"写 TypeScript 代码"降到"写结构化 JSON"同时支持TS代码级别的自定义。agent 生成工作流、用户手写、可视化编辑器产出——三种场景共享同一套声明格式。

---

## 关键设计决策

### 决策 1：Edge.guard 只依赖 NodeCompletion

Edge 不与 AgentInstance 耦合。如果确实有跨节点累积状态的路由需求，由节点将累积数据写入 `completion.result`。

**原则**：YAGNI，信息隐藏。

### 决策 2：上下文为有序栈，非 map

`frames: ContextFrame[]` — 按时间顺序，不按 key 检索。同节点多次访问产生多帧，不会互相覆盖。历史不可篡改。

**原则**：按来源组织，按时间检索。

### 决策 3：Node 自声明配置，Edge 不负责 prepareEntry

tools、subGoal、skill 全部在 Node 自身声明。Runtime 进入节点时直接读目标 Node 的配置，不经过 Edge 中转。同一个节点不管从哪条边进来，配置始终一致。

**原则**：谁拥有信息，谁就声明信息。

### 决策 4：入口使用 Entry，不复用 Edge

Entry 的 guard 接收 `Trigger` 和 `background`，产出第一个实际节点的 `startNodeId` 与可选初始输入。Runtime 将该初始输入包装成 `NodeInput`。Edge 仍只处理节点完成后的迁移，因此入口不再需要伪造 START completion。

**原则**：同构不是目的，类型自洽优先。

### 决策 5：节点只产出原始信号，Edge 负责折叠

Node 产出 `NodeCompletion`（原始数据）。Edge.migrate 将 completion 折叠为 `ContextFrame` 并 push 到栈。不同边对同一 completion 的"记忆"可以不同（答对 vs 答错）。

**原则**：边是完整决策，不同边需不同记忆。

### 决策 6：节点内循环不暴露为图的边

节点内部的 ReAct 迭代（答错→解释→重答）不进入图边系统。只有达成或放弃才产出 NodeCompletion。

**原则**：图显式表达业务阶段，ReAct 内化在节点。

### 决策 7：子图是一等公民，但使用隔离栈

Node 可以是另一个 Graph（`Node.graph`），形成嵌套调用。进入子图时不复用父图 `AgentInstance.frames`，而是创建新的子图实例：`background = NodeInput.data`，`frames = []`。子图完成后，Runtime 将子图最终结果归约为父图 graph 节点的一次 `NodeCompletion`，再由父图 Edge 决定如何折叠进父图 frames。

**原则**：子图是函数式调用边界。父图只看调用结果，不偷看子图内部历史。

### 决策 8：END 为类型安全的 sentinel

`END` 是 `Symbol`，不是虚拟节点。`to: typeof END` 在类型层区分"合法终止"和"遗漏边"。

---

## 组合规则

进入节点时，全局要素与节点要素同时组装：

| 维度   | 来源                                                 | 说明                                           |
| ------ | ---------------------------------------------------- | ---------------------------------------------- |
| 目标   | `instance.globalGoal` + `node.subGoal`           | 聚焦但不覆盖                                   |
| 上下文 | `instance.background` + `frames` + `NodeInput` | 栈帧提供历史，NodeInput 提供当前节点一次性入参 |
| 工具   | `node.tools`                                       | 由目标 Node 自身声明                           |
| 技能   | `node.skill`                                       | 落地为将 skill 文本注入系统提示                |
| 机制   | `instance.mechanisms` ∪ `node.mechanisms`       | 全局与局部叠加                                 |

---

## 运行时（Runtime）

MVP Runtime 只负责单 agent、单活动位置的主循环：

1. 根据 `trigger + background` 在 `Graph.entries` 中选择一个入口。
2. 用 `Entry.input` 构造第一个节点的 `NodeInput`。
3. 执行当前节点：普通节点调用 `execute(instance, input, ctx)`；复合节点由 Runtime 创建隔离子图实例并委托子图执行。
4. 用当前节点的 `NodeRouting` 过滤满足 `guard(completion)` 的边。
5. 按 RouterStrategy 选择唯一一条边。
6. 执行 `Edge.migrate`，把 `frame` push 到 `instance.frames`。
7. 若 `to === END` 则结束；否则把 `MigrationResult.input` 包装为下一节点的 `NodeInput` 并继续。

单 agent 栈模型不支持同时进入多条后继边，因此 MVP 不提供 fork/join；多 agent 通讯和并发帧在后续阶段单独设计。

---

## card_practice 示例（更新为当前设计）

### Node 定义

```typescript
const reviewGraph: Graph = {
  id: "review_loop",
  entries: [
    {
      id: "review_command",
      guard: (trigger) => trigger.command === "/review",
      startNodeId: "select_target",
      input: (trigger) => ({ userMessage: trigger.args }),
    },
  ],
  nodes: {
    select_target: {
      kind: "code",
      id: "select_target",
      subGoal: "选择科目、模式、范围、难度、题型",
      tools: ["review_chapter", "review_exam_points"],
      execute: /* (instance, input, ctx) => 代码主导：选目标 */,
    },
    show_card: {
      kind: "code",
      id: "show_card",
      subGoal: "展示卡片并收集用户动作",
      tools: ["review_card"],
      execute: /* (instance, input, ctx) => 代码主导：渲染 + 等待 */,
    },
    generate_question: {
      kind: "code",
      id: "generate_question",
      subGoal: "生成一道符合当前约束的结构化题目",
      skill: "review-question",
      tools: ["review_card"],
      execute: /* (instance, input, ctx) => agent 主导 */,
    },
    grade: {
      kind: "code",
      id: "grade",
      subGoal: "判断用户答案是否正确并给出解析",
      skill: "review-grade",
      tools: ["review_answer"],
      execute: /* (instance, input, ctx) => agent 主导，内部循环直到答对/放弃 */,
    },
    discuss: {
      kind: "code",
      id: "discuss",
      subGoal: "回答用户追问直到满意",
      skill: "review-discuss",
      execute: /* (instance, input, ctx) => agent 主导 */,
    },
    archive: {
      kind: "code",
      id: "archive",
      subGoal: "归档本题结果并收集下一步",
      tools: ["review_archive", "review_turn_action"],
      execute: /* (instance, input, ctx) => 代码 + agent */,
    },
    summarize: {
      kind: "code",
      id: "summarize",
      subGoal: "生成并保存会话总结",
      skill: "review-summary",
      execute: /* (instance, input, ctx) => agent 主导 */,
    },
  },
  routing: {
    // ... 边的拓扑（YAML 示例见附录）
  },
};
```

### Edge 示例（语法适配新类型）

```yaml
# select_target → show_card
- id: sel_to_card
  from: select_target
  to: show_card
  priority: 10
  guard: completion.result.mode == "card_practice"
  # prepareEntry 已删除；tools 由目标 Node.show_card.tools 声明

# show_card → generate_question
- id: card_to_question
  from: show_card
  to: generate_question
  priority: 10
  guard: completion.result.user_action == "practice"
  migrate:
    frame:
      status: completion.status
      summary: "用户选择了练习模式，知识点：${completion.result.knowledge_point}"
      result: completion.result
    input:
      current_knowledge_point: completion.result.knowledge_point

# grade → discuss（答错需要展开）
- id: grade_to_discuss
  from: grade
  to: discuss
  priority: 10
  guard: completion.result.has_incorrect || completion.result.user_wants_discuss
  migrate:
    frame:
      status: "ok"
      summary: "用户答错，进入讨论"
      result: completion.result
    input:
      # 携带完整错题信息供 discuss 节点使用
      question: completion.result.question
      user_answer: completion.result.user_answer
      wrong_reasons: completion.result.wrong_reasons

# archive → END
- id: archive_exit
  from: archive
  to: END
  priority: 10
  guard: completion.result.turn_action == "exit"
```

### Edge 拓扑（不变）

```
                       ┌─────────────────┐
                       │  select_target   │
                       └───┬─────────┬───┘
                           │ card_   │ practice
                           │ practice│
                           ▼         │
                    ┌──────────┐     │
                ┌───│show_card │─┐   │
                │   └──────────┘ │   │
                │ next_card      │   │
                │ (self-loop)    │ practice
                └────────────────┘   │
                           │         │
                           ▼         ▼
                    ┌──────────────────┐
                ┌───│generate_question │◄──────────────┐
                │   └──────┬───────────┘               │
                │  success │ retry  │ cancelled        │
                │          │(loop)  │                  │
                │          ▼        ▼                  │
                │   ┌──────────┐  [END]                │
                │   │  grade   │                       │
                │   └────┬─────┘                       │
                │ graded  │ graded                     │
                │ +wrong  │ +done                      │
                │    │    │                            │
                │    ▼    ▼                            │
                │ ┌──────────┐                         │
                │ │ discuss  │                         │
                │ └────┬─────┘                         │
                │ retry│ done                          │
                │      │                               │
                │      ▼                               │
                │ ┌──────────┐                         │
                │ │ archive  │                         │
                │ └┬───┬──┬─┘                         │
                │  │   │  └─ exit ──────────────► [END]
                │  │   └─ summary ────► ┌──────────┐  │
                │  │                     │summarize │  │
                │  │ next_question       └────┬─────┘  │
                │  └──────────────────────────┘        │
                │         ┌─────────────────────────────┘
                │  show_  │
                │  card   │
                └─────────┘
```

---

## code + agent 合作边界

| 层                    | 负责方               | 内容                                  |
| --------------------- | -------------------- | ------------------------------------- |
| 图结构                | 代码                 | 节点注册、Edge 声明、Router 策略      |
| Edge guard            | 代码                 | 状态检查、条件评估（只读 completion） |
| Edge migrate          | 代码                 | 栈帧折叠、后继 NodeInput 构造         |
| Node.execute          | agent ReAct 或纯代码 | 内容生成、解释、追问、TUI 交互        |
| 复合节点 (Node.graph) | Runtime 自动委托子图 | 隔离栈调用、子图结果归约              |
| Router 裁决           | 代码或 agent         | 多边选择                              |
| 运行时记录            | 代码                 | 节点执行、边迁移、工具调用日志        |

---

## 设计原则

1. **约束架构骨架，开放业务实现**：框架通过类型固化核心契约，但不阻拦合理的定制化需求
2. **声明式优先**：90% 的节点只需声明 subGoal + tools + skill，SDK 提供标准 execute
3. **类型自洽优先**：入口处理 trigger/background，边处理 NodeCompletion；子图 = 节点，不引入 fork/join 等尚未执行的原语
4. **谁拥有信息，谁就声明信息**：tools 归 Node，guard 归 Edge
5. **边是完整决策**：不仅路由，还包括"怎么记住这段经历"

---

---

## 附录：实施过程中的设计演进

> 以下记录从草案到正式版的修订过程，保留为设计决策的追溯依据。

### 修订 1：guard 只依赖 NodeCompletion

**原设计**：`guard(completion, instance)`。**问题**：所有实际 guard 条件都只看 completion；传入 instance 造成不必要耦合。**决策**：guard 只收 NodeCompletion。

### 修订 2：上下文从 map 改为有序栈

**原设计**：`context: Record<string, unknown>` 以 nodeId 为 key。**问题**：map 无顺序，同节点重复访问互相覆盖。**决策**：改为 `frames: ContextFrame[]` 有序栈。

### 修订 3：删 PrepareEntryResult，配置归 Node

**原设计**：Edge 的 `prepareEntry` 声明目标节点所需配置。**问题**：同一节点配置在每条进入边重复声明，且与 Node 自身字段重叠。**决策**：tools/subGoal/skill 全部归 Node 自身。

### 修订 4：入口使用 Entry，避免 START 伪 completion

**原设计**：曾尝试用 START 边统一入口。**问题**：入口没有 NodeCompletion，Edge.guard 无法类型自洽。**决策**：入口恢复为 Entry，Entry.guard 读取 trigger/background。

### 修订 5：折叠职责从 Node 移到 Edge

**原设计**：Node 内部折叠上下文。**问题**：同一 completion 走不同边需要不同"记忆"。**决策**：Node 只产出原始 NodeCompletion，Edge.migrate 负责折叠。

### 修订 6：Node 声明式优先

远景方向：大多数节点 JSON 声明 + SDK 标准 execute；少数节点自定义 TS。

### 修订 7：机制双挂点，subGoal 为特殊机制

全局机制（AgentInstance）+ 局部机制（Node）双层。subGoal 是必须存在的"构造函数"机制。

### 修订 8：删 keep/discard，子图升为一等公民

`MigrationResult` 简化为 `frame + input?`。`Node.graph` 支持子图组合，替代 `fallbackGraph`。

### 修订 9：Node 互斥类型 + 显式 NodeInput + 多入口 entries

普通节点与复合节点互斥。`NodeInput` 作为节点一次性入参，不进入 AgentInstance 持久字段。多入口由 `Graph.entries` 表达，`Trigger` 通过 Entry.guard 接线。

### 修订 10：删除 graphId 与 fork 策略

`ContextFrame.graphId` 被删除，MVP 阶段只保留线性执行历史，子图路径等调试信息后续通过 trace 表达。`all-satisfied` 和 `Edge[]` 返回被删除；单 agent 栈模型只允许单一后继边。

### 修订 11：子图调用改为隔离栈

**原设计**：子图执行期间沿用父图 frames 继续生长。**问题**：父子图历史混在一条栈里，复合节点边界不清晰，也会重新制造 graphId/tracePath 的压力。**决策**：子图调用创建新的 AgentInstance，`background` 来自调用点传入，`frames = []`。父图 frames 对子图不可见；子图 END 后整体归约为父图 graph 节点的一次 NodeCompletion。

---

## 后续步骤

1. 实现最小 Runtime：entries 入口、priority-first Router、节点→边→迁移主循环
2. 实现 Node 的标准 execute 工厂
3. 实现 2~3 个节点作为概念验证
4. 在现有 review profile 旁并行运行，验证行为等价
5. 逐步迁移更多节点
6. 接入 /review-init 和 /review-fix 为独立子图
7. 欠缺

1. Record<string, unknown> 的可靠性债 —— result/background/inject/inputSchema 全是无类型口袋。你 SDK 卖"可靠性",这债迟早还(泛型化 Node<T></t> 或给 result
   挂运行时 schema 校验)。抽象层可以先欠,具体化时它会第一个找上门。
2. NodeContext 的落地 —— runAgent/callTool 现在是框架级占位,具体化时要映射到 pi 的 setActiveTools + before_agent_start(注系统提示)+ steer +
   terminate:true schema tool 捞 result。这条链是架构 A 能不能跑起来的试金石,建议第一个概念验证节点就打通它,别等搭完再验。
3. agent-choice 的具体形态 —— 内建 kind 声明了,但"agent 怎么选边"仍未落地(注册 choose_next tool?让节点把选择写进 result?)。这是 NodeContext
   链路之外唯一还虚的内建能力。
