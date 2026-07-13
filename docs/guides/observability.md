# 可观测性：logger、traceSink、生命周期事件与调试日志

## 适用场景

你需要观察图运行过程中发生了什么——哪个节点在何时进入、Agent 何时完成推理、是否发生压缩。SDK 默认不写任何日志文件，你需要显式注入观测手段。

## 最小代码

### 1. traceSink：结构化事件收集

```typescript
import { createLoopGraphExtension } from "pi-loop-graph-sdk";

const loop = createLoopGraphExtension(pi, {
  traceSink(event) {
    // 送往外部遥测
    telemetry.record(event);
  },
});
```

所有公开的生命周期事件都会传给 `traceSink`。sink 抛错或异步拒绝不会影响图执行；应把事件当作只读数据使用。

### 2. logger：通用日志输出

```typescript
const loop = createLoopGraphExtension(pi, {
  logger: console,
  traceSink(event) {
    // 可选：同时送往遥测
    metrics.push(event);
  },
});
```

logger 接收框架内部的诊断信息，建议指向 `console` 以在开发时实时观察。

### 3. 本地 JSONL 调试日志

```typescript
const loop = createLoopGraphExtension(pi, {
  debug: true,
  debugLogPath: "loop-graph-debug.log",
});
```

开启后，框架以 JSONL 格式写入文件，每行一个事件。可以用 `tail -f` 实时观察：

```bash
tail -f loop-graph-debug.log
```

## 生命周期事件

| 事件 | 触发时机 | 关键信息 |
| --- | --- | --- |
| `graph_start` | 图开始运行 | graphId、调用边界、调用方式 |
| `node_enter` | 节点进入 | graphId、nodeId、执行周期标识、嵌套深度 |
| `node_exit` | 节点退出 | graphId、nodeId、状态、嵌套深度 |
| `compaction` | 上下文压缩 | graphId、nodeId、压缩代次、原因 |
| `graph_end` | 图正常结束 | graphId、状态、总步数 |
| `graph_error` | 图异常终止 | graphId、错误文本 |

所有事件都包含时间戳和 `graphId`。节点事件还包含当前执行周期标识，可用于关联一次节点进入、退出和压缩。

## 运行规则

1. 初始化时传入 `traceSink`、`logger` 或 `debug: true`；三者互不冲突，可同时使用。
2. 图运行期间，每个生命周期阶段触发对应事件。
3. sink / logger / JSONL 的失败不影响图执行——框架始终保证 sink 的异常被静默捕获。
4. debug JSONL 文件使用同步追加写入；SDK 不负责轮转、清理或多进程协调。

## 安全边界与常见错误

- **生产环境不要开启 `debug: true`**：JSONL 文件会持续增长且可能包含敏感的业务数据（如 prompt 和 result 内容）。生产环境应使用 `traceSink` 送往受控的遥测系统。
- **logger 和 traceSink 是独立的**：logger 不会自动转发到 traceSink，反之亦然。如果你希望统一记录，在 traceSink 中处理即可。
- **不要依赖 `traceSink` 做业务逻辑**：事件是只读快照，且抛错会被静默处理。不要在 sink 中修改图状态或抛出错误来影响执行。
- **debug JSONL 使用同步写入**：高频率事件（如每个 turn 的上下文重组）可能产生大量日志行。考虑配合外部工具做按需过滤。

## 常见调试流程

### 排查“Agent 不退出”

公开生命周期事件目前不包含每次 Agent 完成或验证驳回的详情。先用 `node_enter` 确认卡住的节点，再结合 pi 自身的会话日志检查 `__graph_complete__` 返回的修正原因。若需要长期采集验证详情，应在验证函数或机制中显式记录。

### 排查“图莫名终止”

1. 查找 `graph_error` 事件中的错误文本。
2. 查看最后一个 `node_enter` 或 `node_exit`，定位当时所在节点。
3. 若收到 `graph_end` 而非 `graph_error`，检查该节点是否没有匹配的边。

## 相关概念

- [自动验证](automatic-validation.md) — 如何记录和排查验证驳回
- [上下文自定义](customize-context.md) — context 事件与展示的关系
- [构建循环](build-a-loop.md) — 如何在循环图中使用事件排查死循环
