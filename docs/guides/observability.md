# 可观测性：回放、事件与日志

## 适用场景

你需要观察图运行过程中发生了什么、排查问题、或生成运行报告。

## 工作回放（Replay）

SDK 默认 recording 模式为 `"replay"`，自动生成可持久化的运行记录。

### 生成 replay HTML

```typescript
import { createGraphHost } from "pi-loop-graph-sdk";
import { FileRunStore } from "pi-loop-graph-sdk/replay";

const store = new FileRunStore(".loop-graph/runs");
const host = createGraphHost({ runStore: store, recording: "replay" });

const result = await host.execute(myGraph, input);
// replay JSON 自动保存在 .loop-graph/runs/<runId>/replay.json
```

运行结束后，从 `./replay` 子路径生成 HTML：

```typescript
import { parseReplay, exportReplayHtml } from "pi-loop-graph-sdk/replay";
import { readFile, writeFile } from "node:fs/promises";

const replayJson = await readFile(`.loop-graph/runs/${result.rootRunId}/replay.json`, "utf8");
const model = parseReplay(replayJson);
await writeFile(`report.html`, exportReplayHtml(model), "utf8");
```

### HTML 报告内容

- **模型视角**：每个节点模型看到了什么上下文、产出了哪些文本
- **工具调用**：每次 `__graph_complete__` 的参数和 Runtime 判定（accepted/rejected）
- **时间线**：全部事件的时序视图
- **原始事件**：完整 JSON 事件日志（可折叠）

### Recording 模式

| 模式 | 说明 |
|------|------|
| `"off"` | 不记录 |
| `"events"` | 仅生命周期事件，丢弃大载荷 |
| `"replay"`（默认） | 完整人类可读记录，脱敏密钥和隐藏推理 |
| `"forensic"` | 原始载荷，**警告：可能含敏感数据和隐藏推理** |

### 查看 RunStore

```typescript
import { FileRunStore } from "pi-loop-graph-sdk/replay";

const store = new FileRunStore(".loop-graph/runs");
// journal.jsonl — 可追加的事件流
// replay.json — finalize 后的结构化文档
// checkpoints/ — 运行恢复点（list/prune/delete 管理）
// artifacts/ — 大载荷的外部引用
```

## RunStore 管理

```typescript
import { FileRunStore } from "pi-loop-graph-sdk/replay";

replay HTML 支持通过可注入的 `PricingResolver` 计算费用：

```typescript
const host = createGraphHost({
  pricingResolver: ({ provider, model, usage }) => {
    // 返回该次模型调用的费用（美元）
    return (usage.inputTokens ?? 0) * 0.000001 + (usage.outputTokens ?? 0) * 0.000002;
  },
});
```

## 相关文档

- [API 参考](../reference/api.md) — createGraphHost、RunStore 签名
- [配置项](../reference/configuration.md) — recording 配置
- [`/replay` 子路径](https://www.npmjs.com/package/pi-loop-graph-sdk?activeTab=code) — parseReplay、exportReplayHtml
