# 通讯设计

> 通讯 (Communication) 是一层**高于机制和工具的抽象**。机制和工具是通讯的具体实现方式，上下文是通讯的作用载体。

---

## 1. 三层架构

通讯系统按职责划分为三层：

```
┌──────────────────────────────────────────────────┐
│  Layer 3: 通讯抽象 (Communication)                │
│  - 通讯模式：pub/sub, req/reply, action, shared   │
│  - 通讯协议：寻址、确认、超时、QoS               │
│  - 通讯契约：发起方意图 × 接收方义务              │
├──────────────────────────────────────────────────┤
│  Layer 2: 实现方式 (Implementation)               │
│  - 工具 (Tools)：agent 主动调用                   │
│    publish, subscribe, request, read/write, ...   │
│  - 机制 (Mechanisms)：系统自动执行                 │
│    事件广播、消息路由、状态同步、心跳检测          │
├──────────────────────────────────────────────────┤
│  Layer 1: 作用载体 (Context)                      │
│  - 入站消息 → 上下文条目 (可查询、可折叠)         │
│  - 出站消息 → 上下文记录 (可追溯)                 │
│  - 通讯上下文层隔离于业务上下文层                  │
└──────────────────────────────────────────────────┘
```

**核心原则**：
- 通讯**不是**一个被动读取的数据池，而是一个主动的、受目标引导的行为。
- agent 是否允许通讯、以什么方式通讯，由**当前节点的配置**决定。
- 所有通讯必须在 agent 上下文中留下**可追溯的记录**。

---

## 2. 通讯模式 (参考 ROS2)

参考 ROS2 的四类通讯原语，映射到本系统的 agent 协作场景：

### 2.1 发布/订阅 (Publish/Subscribe)

**对应 ROS2 Topic**：异步、单向、多对多的数据流。

| 属性 | 说明 |
|------|------|
| 方向 | 单向 (publisher → subscribers) |
| 同步性 | 异步 |
| 关系 | 多对多 |
| 典型场景 | 状态广播、事件通知、感知结果分发 |

**在本系统中的映射**：

- **Topic** = 命名通道（如 `agent_status`、`task_progress`、`knowledge_update`）
- **Publisher** = agent 通过工具 `publish(topic, message)` 发送消息
- **Subscriber** = agent 通过工具 `subscribe(topic)` 注册订阅；消息到达时由**机制**自动投递到上下文

```
Agent A ──publish("task_progress", {step: 3, status: "done"})──► [Message Bus]
                                                                      │
                                    ┌─────────────────────────────────┘
                                    ▼
                          Agent B (已 subscribe("task_progress"))
                                    消息自动注入 B 的通讯上下文层
```

**消息结构**：

```typescript
interface PublishedMessage {
  topic: string;
  sender: AgentId;
  timestamp: number;
  payload: Record<string, unknown>;
  qos?: QoS;                    // 可靠性、持久性等
}
```

### 2.2 请求/回复 (Request/Reply)

**对应 ROS2 Service**：同步、一对一、快速 RPC。

| 属性 | 说明 |
|------|------|
| 方向 | 双向 (client ⇄ server) |
| 同步性 | 同步 (调用方等待回复) |
| 关系 | 一对一 |
| 典型场景 | 查询信息、请求决策、能力调用 |

**在本系统中的映射**：

- **Service** = 命名服务（如 `query_profile`、`evaluate_plan`、`translate_text`）
- **Server** = agent 通过工具 `register_service(name, handler)` 注册服务处理函数
- **Client** = agent 通过工具 `request(target, service, payload)` 发起同步调用

```
Agent A ──request(B, "evaluate_plan", {plan: ...})──► Agent B
                                                         │
                                                         ▼
                                                    handler 执行
                                                         │
                                                         ▼
Agent A ◄──────────── {approved: true, score: 0.85} ────┘
```

**请求结构**：

```typescript
interface ServiceRequest {
  requestId: string;
  service: string;
  sender: AgentId;
  payload: Record<string, unknown>;
  timeout?: number;              // 超时 ms，默认 30000
}

interface ServiceReply {
  requestId: string;
  responder: AgentId;
  status: "ok" | "rejected" | "timeout" | "error";
  result?: Record<string, unknown>;
  reason?: string;               // 拒绝或错误原因
}
```

### 2.3 目标/反馈 (Action)

**对应 ROS2 Action**：异步、可取消、带中间反馈的长时间任务。

| 属性 | 说明 |
|------|------|
| 方向 | 双向 + 流式反馈 |
| 同步性 | 异步 |
| 关系 | 一对一 |
| 典型场景 | 任务委派、长时间生成、分阶段执行 |

**在本系统中的映射**：

- **Action** = 命名动作（如 `write_report`、`search_and_summarize`、`multi_step_reasoning`）
- **Action Server** = agent 通过工具 `register_action(name, executor)` 注册执行器
- **Action Client** = agent 通过工具 `send_goal(target, action, goal)` 发送目标，获得反馈流和结果

```
Agent A ──send_goal(B, "write_report", {topic: "AI safety"})──► Agent B
                                                                    │
                                                    ┌───────────────┘
                                                    ▼
                                          feedback: {progress: 0.2, stage: "research"}
                                          feedback: {progress: 0.6, stage: "drafting"}
                                          feedback: {progress: 1.0, stage: "done"}
                                                    │
Agent A ◄────────── result: {report: "...", sources: [...]} ──────┘
```

**Action 结构**：

```typescript
interface ActionGoal {
  goalId: string;
  action: string;
  sender: AgentId;
  goal: Record<string, unknown>;
  deadline?: number;             // 截止时间戳
}

interface ActionFeedback {
  goalId: string;
  progress: number;              // 0.0 ~ 1.0
  stage: string;
  message?: string;
}

interface ActionResult {
  goalId: string;
  status: "succeeded" | "aborted" | "cancelled" | "timeout";
  result?: Record<string, unknown>;
}

// Agent A 可随时调用 cancel_goal(goalId) 取消
```

### 2.4 共享状态 (Shared State)

**对应 ROS2 Parameters + 黑board 模式**：命名键值存储，支持读写和变更监听。

| 属性 | 说明 |
|------|------|
| 方向 | 双向读写 |
| 同步性 | 同步/异步可配 |
| 关系 | 多对多 |
| 典型场景 | 全局配置、协作白板、知识库、任务队列 |

**在本系统中的映射**：

- **Namespace** = 分层命名空间（如 `/task/current`、`/team/agents/A/status`）
- 工具：`read(key)`、`write(key, value)`、`watch(key, callback)`、`delete(key)`
- 机制：写冲突检测、变更通知、租约管理

```
┌──────────────────────────────────────┐
│            Shared State              │
│                                      │
│  /task/current    → {id: "t1", ...}  │
│  /team/leader     → "agent-A"        │
│  /results/output  → {...}            │
│  /config/model    → "gpt-4"          │
│                                      │
└──────┬───────────────┬───────────────┘
       │ read/write    │ read/write
       ▼               ▼
    Agent A          Agent B
```

**状态条目结构**：

```typescript
interface StateEntry {
  key: string;
  value: unknown;
  owner?: AgentId;               // 写入方
  version: number;               // 乐观锁版本号
  ttl?: number;                  // 过期时间 ms
  ephemeral?: boolean;           // 写入方离开图后自动清除
}
```

---

## 3. 实现层：工具 vs 机制

通讯的实现分为两类：**工具**（agent 主动调用）和 **机制**（系统自动执行）。

### 3.1 通讯工具 (Communication Tools)

通讯工具与其他业务工具地位平等，在 `Node.tools` 中声明。agent 在当前节点内可以主动调用它们。

```typescript
// 通讯工具清单
const CommunicationTools = {
  // --- Pub/Sub ---
  publish: {
    name: "publish",
    description: "向指定 topic 发布消息",
    parameters: { topic: "string", payload: "object", qos: "QoS?" },
    returns: "void",
  },
  subscribe: {
    name: "subscribe",
    description: "订阅指定 topic，后续消息自动投递到通讯上下文",
    parameters: { topic: "string", qos: "QoS?" },
    returns: "subscription_id",
  },
  unsubscribe: {
    name: "unsubscribe",
    description: "取消订阅",
    parameters: { subscription_id: "string" },
    returns: "void",
  },

  // --- Request/Reply ---
  request: {
    name: "request",
    description: "向指定 agent 发起同步服务请求",
    parameters: { target: "AgentId", service: "string", payload: "object", timeout: "number?" },
    returns: "ServiceReply",
  },
  register_service: {
    name: "register_service",
    description: "注册一个服务处理函数，供其他 agent 调用",
    parameters: { service: "string", handler: "function" },
    returns: "void",
  },

  // --- Action ---
  send_goal: {
    name: "send_goal",
    description: "向指定 agent 发送异步目标，返回反馈流和结果",
    parameters: { target: "AgentId", action: "string", goal: "object", deadline: "number?" },
    returns: "{ feedbackStream: AsyncIterable, resultPromise: Promise<ActionResult> }",
  },
  cancel_goal: {
    name: "cancel_goal",
    description: "取消已发送的目标",
    parameters: { goal_id: "string" },
    returns: "void",
  },

  // --- Shared State ---
  read_state: {
    name: "read_state",
    description: "从共享状态读取指定 key",
    parameters: { key: "string" },
    returns: "StateEntry | null",
  },
  write_state: {
    name: "write_state",
    description: "写入共享状态（乐观锁）",
    parameters: { key: "string", value: "unknown", expected_version: "number?", ttl: "number?" },
    returns: "{ success: boolean, version: number }",
  },
  watch_state: {
    name: "watch_state",
    description: "监听共享状态变更",
    parameters: { key: "string", pattern: "string?" },
    returns: "watch_id",
  },
  list_state: {
    name: "list_state",
    description: "列出指定命名空间下的所有 key",
    parameters: { namespace: "string" },
    returns: "string[]",
  },
};
```

### 3.2 通讯机制 (Communication Mechanisms)

通讯机制是系统的**横切面基础设施**，不依赖 agent 主动调用，而是由 Runtime 在满足条件时自动执行。它们在 Graph 或 Node 级别配置。

```typescript
interface CommunicationMechanisms {
  // --- 消息分发 (Message Dispatch) ---
  // 当有 agent publish 消息时，自动将消息推送给所有已订阅该 topic 的 agent
  messageDispatch: {
    enabled: boolean;            // 默认 true
    bufferSize: number;          // 未消费消息缓冲区大小
    deliveryPolicy: "best_effort" | "reliable";  // 类似 ROS2 QoS
  };

  // --- 服务注册发现 (Service Discovery) ---
  // 维护全局服务注册表，处理 request 的寻址和路由
  serviceDiscovery: {
    enabled: boolean;
    registry: "global" | "graph_scoped";
  };

  // --- 状态同步 (State Synchronization) ---
  // 处理共享状态的读写冲突、变更通知、租约过期
  stateSync: {
    conflictResolution: "last_write_wins" | "optimistic_lock" | "custom";
    changeNotification: "immediate" | "debounced";
    defaultTTL: number;          // 默认过期时间
  };

  // --- 心跳与存活检测 (Heartbeat) ---
  // 定期检测 agent 实例是否存活，自动清理已离开的 agent 的状态和订阅
  heartbeat: {
    interval: number;            // 心跳间隔 ms
    timeout: number;             // 无响应超时 ms
  };

  // --- 通讯日志 (Communication Log) ---
  // 自动记录所有通讯事件到上下文和运行时日志
  audit: {
    logToContext: boolean;       // 是否写入 agent 上下文
    logToRuntime: boolean;       // 是否写入运行时日志
    level: "all" | "errors" | "none";
  };
}
```

### 3.3 工具与机制的分工

| 维度 | 工具 (Tools) | 机制 (Mechanisms) |
|------|-------------|-------------------|
| 触发方式 | agent 主动调用 | 系统条件触发 |
| 典型操作 | publish, request, send_goal | 消息投递、心跳、冲突解决 |
| 配置位置 | 节点 `Node.tools` | Graph 共享环境 / 节点 `constraints` |
| agent 感知 | 完全感知（参数、返回值） | 部分感知（结果注入上下文） |
| 类比 ROS2 | `rclcpp::Publisher::publish()` | DDS 发现、QoS 策略、Executor |

---

## 4. 上下文集成

通讯通过**上下文层 (Context Layer)** 作用于 agent。每条通讯记录作为一个上下文条目，遵循与其他上下文相同的生活周期。

### 4.1 通讯上下文的隔离

通讯上下文与业务上下文使用**不同的上下文层**：

```
Agent 上下文层级结构
├── Layer 0: 全局记忆 (profile, session, 学习画像)
├── Layer 1: 通讯入站 (incoming_comm)     ← 本节点收到的外部消息
├── Layer 2: 通讯出站 (outgoing_comm)     ← 本节点发出的外部消息
├── Layer 3: 当前阶段业务 (当前节点工作状态)
│   └── ... (节点折叠后只保留摘要)
├── Layer 4: 节点摘要 (前序节点的产出摘要)
```

- **通讯入站层**：节点执行期间收到的订阅消息、服务请求、action 目标，追加到此层
- **通讯出站层**：agent 发出的 publish、request、send_goal，记录到此层
- 通讯层在节点完成时**选择性折叠**：未消费的订阅消息可保留到下一节点（由 Edge.migrate 在 inject 或 ContextFrame 中携带），已消费的消息在 snapshot 生成时丢弃

### 4.2 通讯记录格式

```typescript
interface CommunicationRecord {
  id: string;
  direction: "inbound" | "outbound";
  pattern: "pub_sub" | "request_reply" | "action" | "shared_state";
  channel: string;               // topic / service / action / state key
  counterpart: AgentId | "broadcast";
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "responded" | "consumed" | "expired";
  timestamp: number;
  consumedAt?: number;           // agent 处理时间
}
```

### 4.3 Edge 迁移中处理通讯上下文

Edge 的 `migrate` 可以像操作普通上下文字段一样处理通讯记录：

```typescript
// 例：迁移时保留未处理的订阅消息，丢弃已处理的
{
  migrate: {
    keep: [
      "profile",
      "session",
      "incoming_comm[status=pending]",   // 保留未消费的消息
    ],
    discard: [
      "outgoing_comm",                    // 清空发出记录
      "incoming_comm[status=consumed]",   // 清空已消费的消息
    ],
  }
}
```

---

## 5. 节点对通讯的控制

通讯不是 agent 的自由行为。agent 能否通讯、以哪些方式通讯，完全由**当前节点**通过 `Node.tools` 和 `constraints` 决定。

### 5.1 节点赋予通讯能力

```typescript
// 节点 A：允许 agent 发布自己的进展，但不能请求其他 agent
const agentWorker: Node = {
  id: "agent_worker",
  subGoal: "完成当前任务并报告进展",
  tools: [
    "publish",          // 允许发布消息
    "read_state",       // 允许读共享状态
    "write_state",      // 允许写共享状态
    // 注意：未授予 request、send_goal，此节点 agent 不能向其他 agent 发起同步/异步请求
  ],
  mechanisms: [
    // 可通过机制限制通讯范围
  ],
  constraints: [
    { type: "publish_topics", allow: ["task_progress", "task_result"] },
    // 限制只能向特定 topic 发布
  ],
  execute: async (instance) => { /* ... */ },
};
```

### 5.2 通讯范围约束

节点可以通过 `constraints` 限制通讯的范围：

```typescript
type CommunicationConstraint =
  | { type: "publish_topics"; allow: string[] }           // 允许发布的 topic 白名单
  | { type: "subscribe_topics"; allow: string[] }        // 允许订阅的 topic 白名单
  | { type: "request_services"; allow: string[] }        // 允许调用的 service 白名单
  | { type: "request_targets"; allow: AgentId[] }        // 允许请求的目标 agent
  | { type: "state_namespace"; allow: string[] }         // 允许读写的 state 命名空间
  | { type: "max_message_rate"; perSecond: number }      // 消息频率限制
  | { type: "require_ack"; timeout: number }             // 要求接收方确认
  | { type: "no_communication" }                          // 完全禁止通讯（隔离模式）
  | { type: "broadcast_only" }                            // 只允许广播，不允许点对点
;
```

### 5.3 机制层面限制

机制也可以在节点级别配置（作为 `constraints` 的一部分，由 Node.execute 内或 Runtime 应用）：

```typescript
// 例：高安全性节点，禁止任何外部事件打断 agent 思考
constraints: [
  { type: "no_communication" },           // 工具层面禁止
  { type: "suppress_inbound" },           // 机制层面：暂存入站消息，节点完成后再投递
]
```

---

## 6. 多 Agent 协作场景

### 6.1 场景：分工协作 (Map-Reduce)

```
                  ┌──────────┐
                  │  Planner  │
                  │  (Agent)  │
                  └────┬─────┘
                       │ publish("subtasks", [...])
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
    ┌─────────┐  ┌─────────┐  ┌─────────┐
    │ Worker A│  │ Worker B│  │ Worker C│
    │subscribe│  │subscribe│  │subscribe│
    │"subtasks"│ │"subtasks"│ │"subtasks"│
    └────┬────┘  └────┬────┘  └────┬────┘
         │ publish     │ publish     │ publish
         │("results")  │("results")  │("results")
         └─────────────┼─────────────┘
                       ▼
                  ┌──────────┐
                  │ Reducer  │
                  │subscribe │
                  │"results" │
                  └──────────┘
```

- Planner 通过 `publish` 分发子任务
- Worker 通过 `subscribe` + 机制自动接收
- Reducer 通过 `subscribe` 收集所有结果
- 使用 `read_state`/`write_state` 跟踪全局进度

### 6.2 场景：辩论/评审 (Debate)

```
   Agent A ◄──request/reply──► Agent B
     │                            │
     │  write_state("/debate/round/1/argument_a", ...)
     │  write_state("/debate/round/1/argument_b", ...)
     │                            │
     ▼                            ▼
           ┌──────────────┐
           │  Judge Agent  │
           │ read_state    │
           │ (读取双方论点)│
           └──────┬───────┘
                  │ publish("verdict", ...)
                  ▼
              [所有 agent]
```

### 6.3 场景：层级监督 (Hierarchical Oversight)

```
              ┌──────────────┐
              │  Supervisor  │
              │  Agent       │
              └──┬───┬───┬──┘
                 │   │   │
    send_goal    │   │   │  send_goal
    ("analyze")  │   │   │  ("summarize")
                 ▼   │   ▼
          ┌────────┐ │ ┌────────┐
          │Worker A│ │ │Worker B│
          └───┬────┘ │ └───┬────┘
              │       │     │
    feedback  │       │     │  feedback
    (progress)│       │     │  (progress)
              ▼       ▼     ▼
         Supervisor 通过 heartbeat 监控存活
         通过 cancel_goal 可随时中止子任务
```

### 6.4 场景：图间通讯 (Cross-Graph)

两个独立的 Graph 也可以通过通讯设施交互：

```
Graph: analyzer              Graph: reporter
┌──────────────┐            ┌──────────────┐
│ Agent A      │            │ Agent X      │
│              │            │              │
│ write_state  │            │ watch_state  │
│ /shared/     │───────────►│ /shared/     │
│ analysis/    │  状态同步   │ analysis/    │
│              │  机制自动   │              │
└──────────────┘  触发通知  └──────────────┘
```

前提是两个 Graph 共享同一个 Runtime（或通过外部消息总线桥接）。

---

## 7. 寻址与身份

### 7.1 Agent 寻址方案

```typescript
type AgentAddress =
  | { kind: "id"; agentId: string }                           // 精确寻址
  | { kind: "role"; role: string }                            // 按角色寻址
  | { kind: "node"; nodeId: string }                          // 按所在节点寻址
  | { kind: "query"; filter: Record<string, unknown> }        // 按属性查询
  | { kind: "broadcast"; scope: "graph" | "runtime" }         // 广播
  | { kind: "self" }                                           // 自身
;
```

### 7.2 通讯命名空间

为避免冲突，通讯通道使用分层命名空间：

```
/task/planner/subtasks        # 任务规划器的子任务 topic
/task/worker/results           # worker 的结果 topic
/service/translate/en-zh       # 翻译服务
/service/evaluate/quality      # 质量评估服务
/action/report/generate        # 报告生成 action
/state/session/config          # 会话配置状态
/state/debate/round/1          # 辩论第 1 轮状态
```

---

## 8. QoS 策略 (参考 ROS2)

ROS2 的 QoS 策略为通讯提供了可靠性、持久性和时效性保证。本系统按需支持以下子集：

```typescript
interface QoS {
  // 可靠性
  reliability: "best_effort" | "reliable";
  // best_effort: 消息可能丢失（适用于高频状态更新）
  // reliable: 保证送达（适用于关键指令）

  // 持久性
  durability: "volatile" | "transient_local";
  // volatile: 新订阅者不会收到历史消息
  // transient_local: 新订阅者收到最近的缓存消息

  // 历史
  history: "keep_last" | "keep_all";
  depth?: number;              // keep_last 时保留的最近消息数

  // 截止时间
  deadline?: number;           // 消息最大到达延迟 ms，超时视为丢失

  // 生命周期
  lifespan?: number;           // 消息过期时间 ms，过期自动丢弃
}
```

QoS 在 `publish` 和 `subscribe` 时均可指定，实际应用时取两者的兼容子集。

---

## 9. 通讯协议

收到通讯后，接收方需要按协议响应：

### 9.1 Pub/Sub 协议

```
Sender ──publish(topic, msg)──► Message Bus ──deliver──► Subscriber

Subscriber 行为：
  - 消息自动注入通讯入站上下文层
  - agent 可通过上下文读取或通过 watch_state 模式监听
  - 无需显式确认（除非 QoS.reliability == "reliable"）
```

### 9.2 Request/Reply 协议

```
Client ──request──► Server
                      │
                      ├── accepted ──handler()──► reply
                      │
                      └── rejected ──reason──► Client (错误)
                      
Client 超时处理：
  - timeout 到达 → 通讯入站上下文注入 ServiceReply{status: "timeout"}
  - agent 自行决策重试或放弃
```

### 9.3 Action 协议

```
Client ──send_goal──► Server
                        │
                        ├── accepted ──► feedback stream (多次)
                        │                  │
                        │              ┌───┴───┐
                        │           succeeded  aborted
                        │              │        │
                        └── rejected ──┘        │
                                    │           │
                                    ▼           ▼
                               Client 收到 result
                               
Client 可随时 cancel_goal:
  - 向 Server 发送 cancel 信号
  - Server 的 executor 应检查 cancel 信号并优雅终止
```

### 9.4 Shared State 协议

```
Writer ──write(key, value, version?)──► State Store
                                          │
                                          ├── 版本匹配 / LWW → 写入成功
                                          │
                                          ├── 版本冲突 → 返回 { success: false, current_version }
                                          │
                                          └── 触发 watch 回调 (机制)
                                              │
                                              ▼
                                        所有 watch 该 key 的 agent
                                        通讯入站上下文注入 change 通知
```

---

## 10. 通讯安全与治理

### 10.1 信息边界

```typescript
interface InformationBoundary {
  // 定义哪些上下文字段可以被通讯工具读取并发送出去
  readable: string[];            // 可读取的上下文字段
  // 定义收到外部消息后可以写入哪些上下文字段
  writable: string[];            // 可被外部写入的上下文字段
  // 默认：业务上下文层不可被外部直接写入，只能写入通讯上下文层
}
```

### 10.2 通讯审计

所有通讯事件由 Runtime 记录：

```typescript
interface CommunicationAuditEntry {
  timestamp: number;
  pattern: string;
  channel: string;
  sender: AgentId;
  receiver: AgentId | "broadcast";
  payloadDigest: string;          // 载荷哈希（不记录完整内容以节省空间）
  status: "delivered" | "rejected" | "timeout" | "error";
  latency?: number;               // 处理延迟 ms
}
```

这些审计记录用于：
- 调试多 agent 协作 bug
- 性能分析
- 回溯决策链（"为什么 Agent A 做出了这个决定？因为它收到了来自 Agent B 的消息……"）

---

## 11. 与现有设计的集成

### 11.1 在 CONTEXT.md 术语表中的定位

通讯作为独立术语，在概念层级上：

```
Graph (回路图)
  ├── Node (节点)
  ├── Edge (边)
  ├── Router (路由器)
  ├── AgentInstance (agent 实例)
  ├── Communication (通讯)          ← 新增，完整定义
  │     ├── Tools (通讯工具)
  │     └── Mechanisms (通讯机制)
  └── Composition Rules (组合规则)
```

### 11.2 在 Runtime 中的位置

```typescript
interface Runtime {
  graph: Graph;
  
  // --- 通讯基础设施 ---
  commBus: CommunicationBus;       // 消息总线
  stateStore: SharedStateStore;    // 共享状态存储
  serviceRegistry: ServiceRegistry;// 服务注册表
  commAudit: CommunicationAudit;   // 通讯审计
  
  // --- 执行 ---
  async run(trigger: Trigger): Promise<AgentInstance>;
  async step(instance: AgentInstance): Promise<AgentInstance | null>;
}
```

### 11.3 在 AgentInstance 中的体现

```typescript
interface AgentInstance {
  id: string;
  globalGoal: string;
  context: Record<string, unknown>;     // 包含通讯上下文层
  globalTools: string[];                 // 可能包含通讯工具
  mechanisms: Mechanism[];               // 可能包含通讯机制
  currentNode: string;
  trace: TraceEntry[];
  
  // --- 通讯状态 ---
  subscriptions: Subscription[];         // 当前订阅列表
  registeredServices: string[];          // 已注册的服务
  pendingGoals: string[];               // 待完成的目标 id
}
```

---

## 12. 实现路线图

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| Phase 1 | Shared State（最简协作：读/写共享状态） | 高 |
| Phase 1 | Publish/Subscribe（异步消息投递） | 高 |
| Phase 2 | Request/Reply（同步服务调用） | 中 |
| Phase 2 | 通讯上下文层隔离与 Edge 迁移集成 | 中 |
| Phase 3 | Action（长时间目标 + 反馈） | 低 |
| Phase 3 | QoS 策略 | 低 |
| Phase 4 | 图间通讯 | 低 |
| Phase 4 | 高级寻址（按角色/属性查询） | 低 |
