# Skill Loop SDK 设计草案

> 基于 context.md 回路图抽象 + LangGraph 参考 

## 核心理念

> **Node 像纯函数——声明输入参数和返回值类型。Edge 像调用方——决定什么时候调用、调用前准备什么参数、调用后怎么处理返回值、接下去调哪个函数。**

## 目标

#### **利用pi-agent的extesion机制封装一套贯彻我们设计理念的agent编排工具,让pi-agent平台下的skill不再仅仅只是一个操作手册,而是一个可复用,可管理,具有较高可靠性的技能单元,为在复杂业务场景下使用pi-agent下搭建复杂agent架构提供便利.**

## 五个核心概念

### 1. Node（节点）

**只做一件事：执行工作，产出完成信号。**
不定义入口、不定义出口、不感知 Edge、不知道自己会被谁调用、调完去哪。

```typescript
interface Node {
  id: string;
  
  // 执行体：接收注入后的 AgentInstance，产出完成信号
  execute(instance: AgentInstance): Promise<NodeCompletion>;
}

interface NodeCompletion {
  nodeId: string;
  status: string;                              // 节点内部的语义状态
  result: Record<string, unknown>;               // 结构化产出
  agentHint?: string;                           // agent 可选的语义标注
}
```

**职责约束**：

- Node 内部允许 agent 进行 ReAct
- Node 管理"每个 agent 实例在此阶段的状态"，而非全局单例
- Node 不应隐藏跨节点状态迁移规则
- Node 不直接修改 agent 实例的总目标或持久身份

### 2. Edge（边）

**一等公民。独占条件 + 迁移 + 入口准备。**

```typescript
interface Edge {
  id: string;
  from: string;                                 // 源节点 id（不可为 START）
  to: string | typeof END;                      // 目标节点 id 或终止标记
  priority: number;                             // 数字越大优先级越高

  // 条件判断：只看 NodeCompletion + AgentInstance 公开状态
  guard(completion: NodeCompletion, instance: AgentInstance): boolean;

  // 迁移动作：从上一个节点产出中保留/丢弃/注入上下文
  migrate(instance: AgentInstance, completion: NodeCompletion): {
    keep: string[];                             // 保留哪些上下文字段
    discard: string[];                          // 丢弃哪些上下文字段
    inject: Record<string, unknown>;              // 注入新字段（增量）
  };

  // 进入目标节点前的准备：skill、工具白名单、注意力引导、阶段约束
  prepareEntry(instance: AgentInstance): {
    skills: string[];                           // 注入的 skill 路径
    tools: string[];                            // 本阶段可调用工具 id
    contextFocus: string[];                     // 引导 agent 注意力聚焦
    constraints: Constraint[];                    // 阶段特殊限制
  };
}
```

### 3. Router（路由策略）

**挂在每个源节点的出口处，从多条 Edge 中裁决出最终选择。**

```typescript
type RouterStrategy =
  | { kind: "priority-first" }                 // 最高优先级胜出；同级时取第一个
  | { kind: "agent-choice" }                   // agent 从所有满足条件的边中选
  | { kind: "first-match" }                     // 按注册顺序，第一个满足的生效
  | { kind: "all-satisfied" }                  // 所有满足条件的同时触发（fork）
  | { kind: "custom"; fn: RouterFn };

type RouterFn = (
  satisfiedEdges: Edge[],
  completion: NodeCompletion,
  instance: AgentInstance,
) => Edge | Edge[] | null;

// Router 是源节点的一个属性配位
interface NodeRouting {
  nodeId: string;
  edges: Edge[];
  router: RouterStrategy;
}
```

### 4. Graph（回路图）

**可运行或可复用的 agent 系统图。多入口。**

```typescript
const END = Symbol("graph.end");

type Trigger = {
  command: string;
  args: string;
  userMessage: string;
};

interface Entry {
  guard(trigger: Trigger): boolean;
  targetNode: string;
  prepareEntry: {
    skills: string[];
    tools: string[];
    contextFocus: string[];
    constraints: Constraint[];
  };
  initialContext: Record<string, unknown>;
}

interface Graph {
  id: string;
  entries: Entry[];
  nodes: Record<string, Node>;
  routing: Record<string, NodeRouting>;        // 每个节点最多一组 routing
  fallbackGraph?: Graph;                        // 无匹配 Edge 时切入的异常诊断图
}
```

### 5. AgentInstance（agent 实例）

**回路图中的活动主体。承载跨节点的连续状态。**

```typescript
interface AgentInstance {
  id: string;
  
  // 回路级总体目标
  globalGoal: string;

  // 累积上下文
  context: Record<string, unknown>;

  // 全局工具（跨节点可用）
  globalTools: string[];

  // 全局横切机制
  mechanisms: Mechanism[];

  // 当前所在节点
  currentNode: string;

  // 运行记录
  trace: TraceEntry[];
}
```

---

## 关键设计决策

### 决策 1：Edge 定义入口和出口，Node 不定义

- Node 无 `outputs`、`ports`、`nextNodes` 字段
- Node 只产出 `NodeCompletion`，不去管谁会消费它
- Edge 独占 `guard`（何时触发）、`migrate`（怎么清理/注入上下文）、`prepareEntry`（怎么进入目标节点）
- **同一 Node 在不同 Graph 中被不同 Edge 接入，Node 代码完全不需修改**

### 决策 2：Router 解决多边冲突

- Router 是源节点出口的**聚合裁决者**
- `priority-first`：guard 互斥时够用
- `agent-choice`：需要 agent 语义判断时用（Discuss、TurnAction 等节点）
- 如果 `RouterStrategy` 产出 null（无 Edge 满足），Runtime 切入 `fallbackGraph`（异常诊断图）

### 决策 3：不设 START 虚拟节点

- Graph 自身通过 `entries[]` 声明入口
- Entry 自带 `guard`、`targetNode`、`prepareEntry`、`initialContext`
- 入口的上下文初始化（`initialContext`）比 Edge 的 `migrate`（依赖前一个节点的产出）更自然

### 决策 4：END 仅作为 sentinel

- `END` 是 `Symbol`，不是虚拟节点
- 唯一用途：**编译器区分"故意终止"和"遗漏 Edge"**
  - `to: END` → 合法终止
  - 节点无任何 outgoing edge → 编译错误

### 决策 5：节点内循环不暴露为图的边

- Grade 节点内：用户答错 → 解释 → 重答 → 循环，只有答对或放弃才产生 `NodeCompletion`
- Discuss 节点内：用户追问 → 解释 → 循环，只有说"继续/没问题了"才产生 `NodeCompletion`
- 这些内部 while 循环不进入图的 Edge 系统，避免边爆炸

### 决策 6：迁移由 Edge 显式管理

每条 Edge 显式声明：

- `keep`：从上个节点保留哪些上下文字段到 AgentInstance
- `discard`：丢弃哪些上半场中间状态
- `inject`：注入新的字段（如 `retry_count`、`discussion_summary`）

好处：调试时直接看 Edge 配置就知道上下文怎么变的。

---

## 组合规则

agent 实例和节点要素两套配置**同时组装**到运行中的 agent 身上：

- **目标** = 实例总目标 + 节点子目标（聚焦但不覆盖）
- **上下文** = 实例全局记忆 + 节点局部注意力引导（`contextFocus`）
- **工具** = 实例全局工具 ∪ 节点工具白名单（`prepareEntry.tools`）
- **技能** = `prepareEntry.skills` 注入
- **机制** = 实例全局机制 + 节点局部策略（`constraints`）

节点不直接修改 agent 实例的总目标；全局目标的变更须通过 Edge 的迁移触发实例的目标重规划机制。

---

## 运行时（Runtime）

```typescript
interface Runtime {
  graph: Graph;
  
  // 主循环
  async run(trigger: Trigger): Promise<AgentInstance>;

  // 单步：执行当前节点 → 评估 Router → 执行 Edge 迁移 → 进入下一节点
  async step(instance: AgentInstance): Promise<AgentInstance | null>;
}

// Runtime 的核心循环：
// while (instance.currentNode !== END) {
//   const node = graph.nodes[instance.currentNode];
//   const completion = await node.execute(instance);
//   const routing = graph.routing[instance.currentNode];
//   const candidates = routing.edges.filter(e => e.guard(completion, instance));
//   let edge = resolveRouter(routing.router, candidates, completion, instance);
//   if (!edge) edge = fallbackGraph.resolve(completion, instance);
//   instance = applyMigration(edge, completion, instance);
//   instance = applyEntry(edge, instance);
//   instance.currentNode = edge.to;
// }
```

Runtime 还负责：

- 记录运行证据（节点执行、边迁移、工具调用、agent 输出）
- 捕获异常并切入 fallbackGraph
- 管理工具注册/卸载（进入节点时注册 `prepareEntry.tools`，离开时卸载）

---

## card_practice 完整流程映射

### 图定义

```yaml
graph: review_loop
entries:
  - guard: trigger.command == "/review"
    targetNode: select_target
    prepareEntry:
      skills: []
      tools: [review_chapter, review_exam_points]
    initialContext:
      user_message: trigger.args
```

### Node 列表

| Node                  | 类型             | 说明                                                         |
| --------------------- | ---------------- | ------------------------------------------------------------ |
| `select_target`     | 代码主导         | 选科目/模式/范围/难度/题型                                   |
| `show_card`         | 代码主导         | 展示卡片并收集动作（practice/next_card/skip/exit）           |
| `generate_question` | agent 主导       | 注入 review-question skill，生成结构化题目                   |
| `grade`             | agent + 代码循环 | 注入 review-grade skill，内部循环直到答对/放弃               |
| `discuss`           | agent 主导       | 注入 review-discuss skill，内部循环直到用户结束              |
| `archive`           | 代码 + agent     | 调用 review_archive 归档，调用 review_turn_action 收集下一步 |
| `summarize`         | agent 主导       | 注入 review-summary skill，生成并保存会话总结                |

### Edge 拓扑

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

### 关键 Edge 细节

```yaml
# ===== select_target → show_card =====
- id: sel_to_card
  from: select_target
  to: show_card
  priority: 10
  guard: completion.mode == "card_practice"
  migrate:
    keep: [profile, chapter_id, knowledge_points, difficulty_policy, type_policy]
    discard: [selection_ui_state]
  prepareEntry:
    tools: [review_card]
    contextFocus: ["目标知识点卡片"]

# ===== show_card → show_card（自环） =====
- id: card_next
  from: show_card
  to: show_card
  priority: 10
  guard: completion.user_action == "next_card"
  migrate:
    keep: [profile, card_queue, difficulty_policy, type_policy]
    discard: [current_card_render]
    inject: { card_index: instance.card_index + 1 }
  prepareEntry:
    tools: [review_card]
    contextFocus: ["下一张知识点卡片"]

# ===== show_card → generate_question =====
- id: card_to_question
  from: show_card
  to: generate_question
  priority: 10
  guard: completion.user_action == "practice"
  migrate:
    keep: [profile, current_knowledge_point, difficulty_policy, type_policy]
    discard: [card_render, card_queue_pointer]
  prepareEntry:
    skills: [review-question]
    tools: [review_card]            # 出题时可参考卡片
    contextFocus: ["目标知识点", "难度约束", "题型约束"]

# ===== generate_question → grade =====
- id: gen_to_grade
  from: generate_question
  to: grade
  priority: 10
  guard: completion.generation_valid && !completion.user_cancelled
  migrate:
    keep: [question, knowledge_points, difficulty, type, profile, session]
    discard: [react_trace, temp_reasoning]
  prepareEntry:
    skills: [review-grade]
    tools: [review_answer]
    contextFocus: ["当前题目", "评分标准"]

# ===== grade → discuss =====
- id: grade_to_discuss
  from: grade
  to: discuss
  priority: 10
  guard: completion.has_incorrect || completion.user_wants_discuss
  migrate:
    keep: [question, user_answer, is_correct, grading, profile, session]
    discard: [grade_react_trace]
  prepareEntry:
    skills: [review-discuss]
    contextFocus: ["题目", "错误原因", "相关知识点"]

# ===== discuss → archive =====
# Router: agent-choice（agent 根据用户意图选择 done 还是 retry）
- id: discuss_to_archive
  from: discuss
  to: archive
  priority: 10
  guard: completion.user_done
  migrate:
    keep: [question, user_answer, is_correct, grading, discussion_summary, profile, session]
    discard: [discuss_react_trace]
  prepareEntry:
    tools: [review_archive, review_turn_action]
    contextFocus: ["归档数据", "讨论总结"]

# ===== archive → generate_question（主循环闭环） =====
- id: archive_next_question
  from: archive
  to: generate_question
  priority: 10
  guard: completion.turn_action == "next_question"
  migrate:
    keep: [profile, knowledge_points, difficulty_policy, type_policy, session]
    discard: [current_question, user_answer, grading, discussion_summary]
  prepareEntry:
    skills: [review-question]
    tools: [review_card]
    contextFocus: ["下一个目标知识点", "难度约束"]
```

---

## code + agent 合作边界

| 层                          | 负责方                                                     | 内容                                 |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| **图结构**            | 代码                                                       | 节点注册、Edge 声明、Router 策略     |
| **Edge guard**        | 代码判断或混合判断                                         | 状态检查、条件评估                   |
| **Edge migrate**      | 代码                                                       | 上下文的 keep/discard/inject         |
| **Edge prepareEntry** | 代码                                                       | skill、工具白名单、约束注入          |
| **Node.execute 内部** | agent ReAct                                                | 内容生成、解释、追问                 |
| **Router 裁决**       | 代码（priority-first/first-match）或 agent（agent-choice） | 多边选择                             |
| **异常诊断**          | fallbackGraph                                              | 资料缺失、工具失败、状态不一致       |
| **运行时记录**        | 代码                                                       | 节点执行、边迁移、工具调用结构化日志 |

---

---

## 实施过程中的设计演进

> 从设计草案到代码落地过程中，经过讨论产生了多项重要修订。
> 以下记录每个修订的**动机、决策和影响**，作为后续开发的设计依据。

---

### 修订 1：guard 只依赖 NodeCompletion，不拿 AgentInstance

**原设计**：`guard(completion, instance)` — Edge 同时检查节点产出和 agent 累积状态。

**发现问题**：
- 实际所有 guard 条件（`completion.mode == "card_practice"`、`completion.user_action == "next_card"` 等）都只看 completion 字段，`instance` 形参从未被使用。
- 传入 `instance` 造成 Edge 与 agent 内部状态耦合，降低复用性。
- 单测需要 mock 两层对象（NodeCompletion + AgentInstance），比只 mock 一层复杂。

**设计原则**：如果一项能力当前不需要、且没有充分理由预判将来需要，就不要加。YAGNI（You Aren't Gonna Need It）。

**决策**：`guard` 只接收 `NodeCompletion`。如果将来确实有跨节点累积状态的路由需求（如"累计答错 5 题后自动切入诊断子图"），应由节点将累积数据写入 `completion.result`，而非让 Edge 直接读取 `instance.context`。

**影响**：
- Edge 接口简化，测试成本降低
- 信息隐藏：Edge 不需要知道数据来源（是 instance 状态还是节点本轮的产出）

---

### 修订 2：上下文按 nodeId 分层组织

**原设计**：上下文以扁平字段存储，`migrate.keep` 列出需要保留的字段名（如 `profile`、`chapter_id`、`question`）。

**发现问题**：
- 字段名散落，难以追踪"哪个节点产出了什么"。
- 迁移时需要逐个声明字段，粒度太细，写起来繁琐。
- 同一个节点可能在上下文中留下多处痕迹，批量丢弃困难。

**新方案**：
- `AgentInstance.context` 以 `nodeId` 为 key 分层组织。
- 已完成节点的上下文被折叠为 `CompletedNodeSnapshot`（status + summary + result）。
- 当前节点在 `execute` 内部开设隔离层，不对外暴露中间过程。
- `migrate.keep` / `migrate.discard` 操作粒度为**节点 ID**（而非字段），批量操作更简洁。

**设计原则**：上下文应按**来源**组织而非按**内容**组织。来源可追溯，迁移可批量。

**影响**：
- 上下文结构从"扁平字段"变为"按节点分层"
- `CompletedNodeSnapshot` 作为节点折叠后的标准输出格式
- 节点自己负责在完成时折叠上下文（生成 summary），Edge 不参与折叠逻辑

---

### 修订 3：Node 自声明配置，删掉 PrepareEntryResult

**原设计**：进入节点所需的信息（tools、skills、contextFocus）由 Edge 的 `prepareEntry` 方法产出，以 `PrepareEntryResult` 类型中转。

**发现问题**：
- 同一个节点不管从哪条边进来，它需要的 tools/skills 是一样的。让每条 Edge 重复声明同一组配置，既冗余又容易出现不一致。
- `Node` 已经有 `subGoal`、`skill`，`PrepareEntryResult` 又有 `skills`、`contextFocus`。信息散落在 Node 和 Edge 两处，Runtime 需要拼装，职责不清。

**设计原则**：谁拥有信息，谁就声明信息。不要为了"可能被覆盖"的假想需求而引入中间层。

**决策**：
- 删除 `PrepareEntryResult` 类型。
- `tools`、`subGoal`、`skill` 全部声明在 `Node` 自身。
- Runtime 进入节点时直接读取 `graph.nodes[targetNodeId]`，不经过 Edge 中转。

**影响**：
- 节点成为"自描述"的完整单元：看一眼 Node 定义就知道它需要什么。
- Edge 的职责收窄为纯粹的**状态迁移**（guard + migrate）。
- `PrepareEntryResult` 和 `MigrationResult` 两个中间类型被删除，代码量减少。

---

### 修订 4：删掉 Entry，用虚拟 START 节点统一入口

**原设计决策 3**："不设 START 虚拟节点"，Graph 通过 `entries[]` 声明多入口，Entry 自带 `guard`、`targetNode`、`prepareEntry`、`initialContext`。

**发现问题**：
- Entry 是独立于 Node/Edge 体系的特殊结构，增加了 Runtime 需要处理的特殊情况。
- 入口边也需要 guard（匹配命令）、migrate（注入初始上下文）、路由（多入口选择），而这些能力已经在 Edge 中实现了。
- 如果入口也是 Edge，则 Runtime 不需要"入口匹配"和"边匹配"两套逻辑。

**设计原则**：统一优于特殊。如果已有机制能做，就不引入新机制。

**决策**：
- 删除 `Entry` 类型。
- Graph 增加 `startNodeId`（第一个实际节点）。
- 入口边放在 `routing["START"]` 中，使用与普通边完全相同的 `Edge` 类型。
- 入口上下文注入通过 Edge 的 `migrate.inject` 完成（代替原 Entry 的 `initialContext`）。

**影响**：
- 撤销原决策 3。
- Runtime 只需维护一套"节点 → 路由 → 边 → 迁移"的循环，无入口特判。
- Graph 的 `entries` 字段替换为 `routing["START"]` + `startNodeId`。

---

### 修订 5：Edge.migrate 从函数降级为数据声明

**原设计**：`migrate(instance, completion): MigrationResult` — 一个函数，可以在运行时根据 completion 动态决定 keep/discard/inject。

**发现问题**：
- 90% 的场景中迁移规则是静态的：不管节点返回什么 completion，迁移策略不变。
- 函数形式暗示了"需要动态计算"，但实际很少用到。
- 与"声明式优先"的总体方向不一致——如果 Node 以 JSON 声明为主，Edge 也应该尽量数据化。

**决策**：`Edge.migrate` 改为直接的数据对象 `{ keep, discard, inject }`，不再接受参数。

**保留空间**：如果将来确实有需要根据 completion 动态计算的场景（如根据答对/答错注入不同信息），该逻辑应由**节点**在折叠时将动态信息写入 `CompletedNodeSnapshot`，Edge 只做节点级别的保留/丢弃。

**影响**：
- Edge 配置更接近 JSON，利于 agent 生成工作流。
- `migrate` 从方法签名变为数据字段，与 Node 的声明式风格统一。

---

### 修订 6：Node 声明式优先（JSON + TS 双层）

**远景方向**（尚未完全落地到类型层，但已指导当前设计）：

- **90% 的节点只需要声明**：`{ id, subGoal, skill?, tools? }` + SDK 提供的标准 `execute` 实现（自动注入 skill、驱动 LLM、检查 subGoal 完成、生成 summary）。这类节点可以纯 JSON 编写。
- **10% 的节点需要自定义 TS**：复杂的循环逻辑、特殊校验、与外部系统交互。这类节点在声明基础上 override `execute`。

这个方向影响了修订 3、4、5 的所有决策——**删掉中间类型、减少抽象层、让配置靠近声明方**，都服务于"让大多数工作流可以 JSON 描述"的目标。

---

### 设计决策汇总

| 修订 | 做了什么 | 否定的原设计 | 核心原则 |
|------|----------|-------------|----------|
| 1 | guard 只收 NodeCompletion | 同时传入 AgentInstance | YAGNI，信息隐藏 |
| 2 | 上下文按 nodeId 分层 | 扁平字段 | 按来源组织，非按内容 |
| 3 | 删 PrepareEntryResult，配置归 Node | Edge 声明节点入口配置 | 谁拥有谁声明 |
| 4 | 删 Entry，用 START 虚拟节点 | 多入口 Entry 数组 | 统一优于特殊 |
| 5 | migrate 降级为数据声明 | migrate 为函数 | 声明式优先 |
| 6 | Node 声明式优先 | Node = 纯代码实体 | 降低工作流编写门槛 |

---

## 后续步骤（更新）

基于上述修订，优先级调整为：

1. **实现最小 Runtime**：支持 priority-first Router、虚拟 START 入口、节点→边→迁移主循环
2. **实现 Node 的标准 execute 工厂**：agent 节点自动注入 skill、检查 subGoal、生成 summary
3. **实现 2~3 个节点作为概念验证**：使用声明式配置 + SDK 标准 execute
4. **在现有 review profile 旁并行运行**，验证行为等价
5. **逐步迁移更多节点**：archive → discuss → summarize → show_card
6. **接入 /review-init 和 /review-fix** 为独立子图
