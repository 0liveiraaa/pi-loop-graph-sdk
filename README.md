# pi-loop-graph-sdk

面向 Pi 的 0.2 图编排 SDK。公共入口提供 Graph/Node Builder、Graph Host、结果协议与 Pi Extension 工厂；运行时诊断和低层适配器位于 `pi-loop-graph-sdk/advanced`，回放工具位于 `pi-loop-graph-sdk/replay`。

```ts
import { Type } from "typebox";
import { codeNode, connect, createGraphHost, defineGraph, entry, finish, firstMatch } from "pi-loop-graph-sdk";

const Input = Type.Object({ name: Type.String() });
const Output = Type.Object({ message: Type.String() });
const graph = defineGraph({
  id: "hello", version: "1", goal: "greet", input: Input, output: Output,
  entries: [entry("main", { to: "greet" })],
  stages: {
    greet: {
      node: codeNode({
        subGoal: "greet", input: Input, output: Output,
        execute: ({ input, complete }) => complete({ message: `Hello, ${input.name}` }),
      }),
      route: firstMatch({ done: finish({ output: ({ completion }) => completion.result }) }),
    },
  },
});

const result = await createGraphHost().execute(graph, { name: "World" });
```

Agent completion 使用严格的 `graph_complete({ result })` 协议；`status` 不属于模型提交内容，由 Runtime 决定。`GraphRunResult` 的失败信息位于 `failure`。

常用导出包括 `defineGraph`、`defineSingleAgentGraph`、`defineLinearGraph`、`agentNode`、`codeNode`、`graphNode`、`graphRef`、`entry`、`connect`、`finish`、`firstMatch`、`createGraphHost`、`executeIsolatedGraph` 和 `createLoopGraphExtension`。

Phase 10 当前仅支持可靠的单层 Root checkpoint/resume；嵌套 call/compose/delegate continuation 恢复仍 fail-closed。真实 LLM 测试需设置 `PI_LIVE_TESTS=1`。Study Helper 六张图业务回归不属于默认验证范围。

更多内容：[`docs/getting-started.md`](docs/getting-started.md)、[`docs/migration-0.1-to-0.2.md`](docs/migration-0.1-to-0.2.md)。

默认不会写调试日志文件；如需启用旧版调试输出，请显式设置 `debug: true`。
