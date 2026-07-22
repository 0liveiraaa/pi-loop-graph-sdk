/**
 * 一行命令运行一张 Agent 图并生成 replay HTML
 *
 * 用法:
 *   node scripts/run-demo.mjs
 *
 * 环境变量（可选）:
 *   PI_MODEL_PROVIDER=deepseek
 *   PI_MODEL_ID=deepseek-v4-flash
 *
 * 输出: .loop-graph/runs/<runId>/report.html
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createPiGraphHost } from "../dist/adapter/isolated-graph-session.js";
import { FileRunStore } from "../dist/replay/store.js";
import { parseReplay, exportReplayHtml } from "../dist/replay/index.js";
import { Type } from "../dist/index.js";
import { defineGraph, agentNode, codeNode, connect, entry, finish, firstMatch } from "../dist/index.js";

// ── 定义一张双节点图 ──
// 1. "think" Agent 节点：让模型思考并生成分析
// 2. "answer" Agent 节点：基于分析给出最终答案

const thinkNode = agentNode({
  subGoal: "分析问题并制定回答策略",
  input: Type.Object({ topic: Type.Optional(Type.String()) }),
  output: Type.Object({ analysis: Type.String() }),
  prompt: `你是一个分析助手。请分析"机器学习"和"深度学习"的区别，用三个要点总结。

当你分析完成后，调用 __graph_complete__ 提交结果，result 格式必须是 { "analysis": "你的分析内容" }。`,
});

const answerNode = agentNode({
  subGoal: "给出最终精炼答案",
  input: Type.Object({ topic: Type.Optional(Type.String()), analysis: Type.Optional(Type.String()) }),
  output: Type.Object({ answer: Type.String() }),
  prompt: `基于前面的分析，用以下格式给出最终答案并提交：
1. <第一个要点>
2. <第二个要点>  
3. <第三个要点>
例子：...
一句话总结：...

调用 __graph_complete__ 时 result 格式必须是 { "answer": "你的完整答案" }。`,
});

const demoGraph = defineGraph({
  id: "ml-demo",
  version: "1",
  goal: "解释机器学习与深度学习的区别",
  input: Type.Object({ topic: Type.String() }),
  output: Type.Object({ answer: Type.String() }),
  context: {
    background: { select: "all" },
    memory: { select: (frames) => frames.map(f => f), render: ({ selected }) => selected ? `=== 已完成阶段 ===\n${JSON.stringify(selected)}` : null },
  },
  entries: [entry("main", { to: "think" })],
  stages: {
    think: {
      node: thinkNode,
      route: firstMatch({
        next: connect("answer", {
          map: ({ completion }) => completion.result,
          frame: ({ completion }) => ({ stage: "think", result: completion.result }),
        }),
      }),
    },
    answer: {
      node: answerNode,
      route: firstMatch({
        done: finish({
          output: ({ completion }) => ({ answer: JSON.stringify(completion.result) }),
          frame: ({ completion }) => ({ stage: "answer", result: completion.result }),
        }),
      }),
    },
  },
});

// ── 运行 ──
const cwd = resolve(process.cwd());
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const requestedProvider = process.env.PI_MODEL_PROVIDER;
const requestedId = process.env.PI_MODEL_ID;
const model = requestedProvider && requestedId
  ? modelRegistry.find(requestedProvider, requestedId)
  : modelRegistry.getAvailable()[0];

if (!model) {
  console.error("No authenticated model available.");
  console.error("Configure Pi auth first, or set PI_MODEL_PROVIDER and PI_MODEL_ID.");
  process.exit(1);
}

console.log(`Using model: ${model.provider}/${model.id}`);

const store = new FileRunStore();
const host = await createPiGraphHost({
  authStorage,
  modelRegistry,
  model,
  cwd,
  runStore: store,
  recording: "replay",
});

try {
  console.log("Running graph...");
  const result = await host.execute(demoGraph, { topic: "ML vs DL" }, { recording: "replay" });

  const replayPath = store.location(result.rootRunId);
  const replayJson = await readFile(`${replayPath}/replay.json`, "utf8");
  const modelView = parseReplay(replayJson);

  const htmlPath = `${replayPath}/report.html`;
  await writeFile(htmlPath, exportReplayHtml(modelView), "utf8");

  console.log(`\nStatus: ${result.status}`);
  if (result.status === "completed") {
    console.log(`Steps: ${result.steps}`);
    console.log(`Duration: ${result.durationMs}ms`);
    console.log(`Output:`, result.output);
  } else {
    console.log(`Failure: ${result.failure?.message}`);
  }
  console.log(`\n📊 Replay HTML: ${htmlPath}`);
  console.log(`   用浏览器打开即可查看`);
} finally {
  await host.dispose();
}
