// ============================================================
//  示例：复习回路图（MVP 最小验证）
// ============================================================
//
//  一个极简的复习图，用于验证 Loop Graph Runtime 闭环：
//
//   /review → [echo] → [END]
//
//   echo 节点：接收用户参数，agent 复述并调用
//   __graph_complete__ 完成。
//
//   这是 MVP 功能闭环测试的最简图——只验证：
//   1. 命令触发图运行
//   2. 节点进入消息注入
//   3. agent 调用 __graph_complete__
//   4. 图正常到达 END
//   5. 帧栈持久化
// ============================================================

import type {
  Edge,
  Entry,
  Graph,
  Node,
  NodeCompletion,
  NodeRouting,
} from "../type.js";
import { END } from "../type.js";

const echoNode: Node = {
  kind: "code",
  id: "echo",
  subGoal: "确认接收到的参数并返回",
  tools: [],
  // 纯代码节点：不跑 agent，直接返回
  async execute(instance, input, _ctx) {
    const received = input.data.args ?? JSON.stringify(input.data);
    return {
      nodeId: "echo",
      status: "ok",
      result: {
        message: `已收到参数: ${received}`,
        received: input.data,
      },
    };
  },
};

const echoEntry: Entry = {
  id: "echo_entry",
  guard: (background: Record<string, unknown>) => {
    // 任何 background 都匹配（MVP 唯一入口）
    return true;
  },
  startNodeId: "echo",
  mapInput: (background) => background,
};

const echoEdge: Edge = {
  id: "echo_to_end",
  from: "echo",
  to: END,
  priority: 10,
  guard: (_completion: NodeCompletion) => true,
  migrate(instance, completion) {
    return {
      frame: {
        nodeId: completion.nodeId,
        status: completion.status,
        summary: `echo 节点完成: ${completion.result.message ?? ""}`,
        result: completion.result,
      },
      // END 边不需要 input
    };
  },
};

export const reviewGraph: Graph = {
  id: "review_echo_test",
  goal: "验证 Loop Graph Runtime 闭环",
  invocation: {
    name: "echo-test",
    description: "测试 Loop Graph Echo 回路",
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "string", description: "任意文本参数" },
      },
    },
    parseArgs(args: string): Record<string, unknown> {
      return { args: args || "(无参数)" };
    },
  },
  entries: [echoEntry],
  nodes: {
    echo: echoNode,
  },
  routing: {
    echo: {
      nodeId: "echo",
      edges: [echoEdge],
      router: { kind: "priority-first" },
    },
  },
};
