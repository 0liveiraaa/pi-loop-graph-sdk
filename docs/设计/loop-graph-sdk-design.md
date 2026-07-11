# Loop Graph SDK 设计

> 基于 CONTEXT.md 回路图抽象，经过多轮实施讨论演进至此。

## 心智模型：栈式子图编排

AgentInstance 持有一个**有序逻辑帧栈**。每进入一个节点就在栈上生长一层，离开节点时由边负责折叠；`compose` 可在同一栈上建立临时帧段，并在退出时强制将该段归约为一个父级帧。完整不可变历史由 trace/audit 保存，而不是要求模型可见 frames 永不归约。

图调用是一等公民：Node、用户命令和 agent 工具都可调用 Graph，但入口与执行边界正交。`compose` 共享 Session/Instance 和父 frames 前缀；`call` 复用 Session、创建隔离 Instance；`delegate` 创建独立 Session/Instance。三者都必须结构化退出并向调用方交付结果。

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

**图复用**：复合 Node 引用另一个 Graph，并显式选择 `compose`、`call` 或 `delegate` 边界。当前实现的 `Node.graph` 为 `call`；命令和工具未来统一默认使用 `delegate`。

### 5. AgentInstance（agent 实例）

回路图中的活动主体，持有一个有序帧栈。

### 6. ContextFrame（栈帧）

栈中的一层。每进入一个节点就 push 一帧；离开时由 Edge.migrate 填写。

### 7. Mechanism（机制）

横切面基础设施。全局（AgentInstance）和局部（Node）双层挂载。subGoal 是特殊的"构造函数"机制——必须存在，定义节点身份，因此在 Node 上以顶层字段而非数组元素存在。

---

## 声明式 API（暂缓）

SDK 最终对外提供两层接口：

**声明层（JSON）**——未来目标。用户或 agent 用声明式格式编写工作流。编译入口 `compileGraph(def, custom, subGraphs)` 将 JSON 定义 + TS 补充编译为运行时 `Graph`。

**补充层（TS）**——当前形态。所有定制点都是函数：`execute`、`guard`、`migrate`、`validateCompletion`、`Entry.guard`。

> 当前 MVP 只实现 TS 层。声明层待后续版本。
>
> 理由：先验证 Runtime 核心（投影、循环、帧栈）是否可靠，再在此基础上设计声明层。过早做声明式编译器会导致 Runtime 和编译器耦合，两样都做不好。

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

### 决策 7：图复用是一等公民，调用边界必须显式

Graph 可以作为另一个 Graph 的节点实现，也可以通过命令或工具调用。调用入口与执行边界正交，边界分为 `compose`、`call`、`delegate`：组合复用 Session/Instance 并在父栈形成必须折叠的帧段；调用复用 Session 但创建新 Instance；委托同时创建新 Session 和新 Instance。

**原则**：命令与工具共享同一图调用协议；图复用必须显式选择上下文共享强度。当前 `kind: "graph"` 保持 `call` 语义以兼容已有行为，`compose` 与统一 `delegate` 接线属于后续实现。

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

| 层                    | 负责方               | 内容                                      |
| --------------------- | -------------------- | ----------------------------------------- |
| 图结构                | 代码                 | 节点注册、Edge 声明、Router 策略          |
| Edge guard            | 代码                 | 状态检查、条件评估（只读 completion）     |
| Edge migrate          | 代码                 | 栈帧折叠、后继 NodeInput 构造             |
| Node.execute          | agent ReAct 或纯代码 | 内容生成、解释、追问、TUI 交互            |
| 复合节点 (Node.graph) | Runtime 执行被引用图 | 显式 compose/call/delegate 边界与结果归约 |
| Router 裁决           | 代码或 agent         | 多边选择                                  |
| 运行时记录            | 代码                 | 节点执行、边迁移、工具调用日志            |

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

### 修订 6：现阶段实现高度可定制化,后续提供声明式编程可能

远景方向：大多数节点 JSON 声明 + SDK 标准 execute；少数节点自定义 TS。

### 修订 7：机制双挂点，subGoal 为特殊机制

全局机制（AgentInstance）+ 局部机制（Node）双层。subGoal 是必须存在的"构造函数"机制。

### 修订 8：删 keep/discard，子图升为一等公民

`MigrationResult` 简化为 `frame + input?`。`Node.graph` 支持子图组合，替代 `fallbackGraph`。

### 修订 9：Node 互斥类型 + 显式 NodeInput + 多入口 entries

普通节点与复合节点互斥。`NodeInput` 作为节点一次性入参，不进入 AgentInstance 持久字段。多入口由 `Graph.entries` 表达，`Trigger` 通过 Entry.guard 接线。

### 修订 10：删除 graphId 与 fork 策略

`ContextFrame.graphId` 被删除，MVP 阶段只保留线性执行历史，子图路径等调试信息后续通过 trace 表达。`all-satisfied` 和 `Edge[]` 返回被删除；单 agent 栈模型只允许单一后继边。

### 修订 11：子图调用改为隔离栈（已被修订 12 扩展）

**原设计**：子图执行期间沿用父图 frames 继续生长。**问题**：父子图历史混在一条栈里，复合节点边界不清晰，也会重新制造 graphId/tracePath 的压力。**决策**：子图调用创建新的 AgentInstance，`background` 来自调用点传入，`frames = []`。父图 frames 对子图不可见；子图 END 后整体归约为父图 graph 节点的一次 NodeCompletion。

### 修订 12：AgentSession 与 AgentInstance 解耦，图调用分为三种边界

**问题**：顶层工具使用独立 AgentSession，内部子图使用 AgentInstance 隔离，使二者看起来像两套互斥的图执行模型；同时，“图代替点”的代码组合需求与函数式隔离需求被压进同一个 `kind: "graph"`。**决策**：AgentSession 是物理执行边界，AgentInstance 是逻辑活动身份；图调用显式区分 `compose`、`call`、`delegate`。`compose` 共享父 frames 前缀并在退出时强制折叠新增帧段；`call` 使用同 Session 的新 Instance；`delegate` 使用新 Session 与新 Instance。命令和 agent 工具统一产生 GraphRunRequest 并消费 GraphRunResult，仅展示适配不同。

完整决策见 [ADR-0001](../adr/0001-graph-invocation-boundaries.md)。

---

## 后续步骤

### 已完成的里程碑

1. ✅ 最小 Runtime：entries 入口、priority-first Router、节点→边→迁移主循环
2. ✅ Node 的标准 execute 工厂（`createAgentExecute`）
3. ✅ 2~3 个概念验证节点（echo、probe、chain、subgraph、validate）
4. ✅ pi 单 agent MVP 验证通过（NodeScope v2 严格投影、帧栈折叠、子图隔离、完成度验证）
5. ✅ 包边界修复：`createLoopGraphExtension(pi)` 工厂 + 实例级 `GraphRegistry`
6. ✅ library / debug extension 分离（`"."` vs `"./extension"`）
7. 🔜 在现有 review profile 旁并行运行，验证行为等价

### 能力债路线图

#### P1：多 skill 支持

目标设计：

```typescript
interface Graph {
  skills?: string[];
}

// CodeNode 增加 skills 数组
skills?: string[];
skill?: string; // deprecated compatibility alias
```

运行时合并规则：

```text
graph.skills + node.skills + (node.skill ? [node.skill] : [])
```

先做完 package/runtime factory 后再动，确保 API 兼容性可测试。

#### P1：schema helper 先于泛型

短期目标：提供运行时 schema 校验工具函数

```typescript
node.inputSchema
node.outputSchema
edge.inputSchema
createRequireFieldsValidator(["question", "answer"])
```

长期目标：泛型类型安全

```typescript
Node<TInput, TResult>
Edge<TFromResult, TToInput>
```

先做 schema helper，因为它的价值直接体现在 `createAgentExecute` 的验证上，不需要大规模类型系统改写。

#### P2：agent-choice 标记为 experimental

当前 `RouterStrategy` 中 `{ kind: "agent-choice" }` 会 `throw Error`。

在明确实现方案前，用户文档标注为 experimental：

> `agent-choice` is declared for future compatibility and currently experimental. Use `custom` if a graph needs model-assisted route selection.

在确认实现前不暴露为稳定 API。候选方案：

- `completion.result.next_edge_id`
- `__graph_choose_edge__` 工具
- Router prompt over candidate edges

#### P1：callTool 等待 pi API 确认

当前 `PiNodeContext.callTool()` 抛异常。纯代码节点建议直接 import 业务库函数。

在实现前需要确认 pi 是否暴露稳定的 extension-side 工具调用 API。如果没有，保持当前明确错误提示，并强化文档说明：纯代码节点可调 domain services 直接完成动作。

### 潜力探索

- 多 agent 通讯（`communication-design.md` 三层架构）
- 声明式编译器（JSON → 编译为运行时 Graph）
- 帧栈持久化（session 续跑）
