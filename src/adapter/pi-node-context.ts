// ============================================================
//  PiNodeContext — Promise 桥接
// ============================================================
//
//  实现 NodeContext 接口，将 pi 的事件驱动模型桥接为
//  Promise 风格的同步等待，让 Runtime 可以用 async/await
//  写主循环。
//
//  runAgent() 的工作流：
//    1. 注入节点进入消息（customType: loop_graph_enter_node）
//    2. 通过 pi.setActiveTools 切换到当前节点工具白名单
//    3. 构造 NodeCompletion Promise
//    4. 注册 agent_end + tool_result 事件监听
//    5. pi.sendMessage 发送 prompt 触发 agent 运行
//    6. agent 工作期间产生中间消息（可被 compaction 压缩）
//    7. agent 调用 __graph_complete__ → tool_result 捕获参数
//    8. agent_end 触发 → resolve Promise → 返回 NodeCompletion
//
//  关键点：
//    - __graph_complete__ 的 execute 透传参数到 NodeCompletion
//    - agent_end 时如果 __graph_complete__ 未被调用，视为失败
//    - 节点的中间过程（ReAct、工具调用）保留在 messages 中，
//      节点完成后由 Edge.migrate 决定如何折叠进帧栈
//    - 帧栈（frames）在 JS 层持久化，不受 compaction 影响
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentInstance,
  AgentRunRequest,
  AgentRunResult,
  Node,
  NodeCompletion,
  NodeContext,
  NodeInput,
} from "../type.js";
import { COMPLETE_TOOL_NAME } from "./complete-tool.js";
import {
  buildNodeEntryMessage,
  ENTER_NODE_CUSTOM_TYPE,
} from "./node-entry.js";

/** 运行一个节点的 agent 所需的最小上下文 */
export interface PiNodeContextOptions {
  pi: ExtensionAPI;
}

export class PiNodeContext implements NodeContext {
  readonly signal: AbortSignal;

  private pi: ExtensionAPI;
  private currentNodeId: string | null = null;

  /** 当前节点的 AgentInstance 和 NodeInput（由 runtime 在进入节点前设置） */
  private currentInstance: AgentInstance | null = null;
  private currentNode: Node | null = null;
  private currentInput: NodeInput | null = null;

  /** agent_end 期间捕获到的 __graph_complete__ 参数 */
  private pendingCompletion: NodeCompletion | null = null;

  /** 当前活跃的 runAgent 操作的唯一 ID。用于在 agent_end handler 中识别是否应 resolve */
  private activeRunId: number = 0;
  private nextRunId: number = 1;

  /** 当前活跃的 Promise resolve/reject */
  private activeResolve: ((c: NodeCompletion) => void) | null = null;
  private activeReject: ((e: Error) => void) | null = null;

  constructor(options: PiNodeContextOptions) {
    this.pi = options.pi;
    // MVP：创建一个简单的 AbortController
    this.signal = new AbortController().signal;
  }

  // ── 供 Runtime 在进入节点前调用 ─────────────────────

  /**
   * Runtime 在进入节点前调用此方法，设置 PiNodeContext 的
   * 当前运行上下文。后续 runAgent() 使用这些信息构造注入消息。
   */
  prepareNodeRun(
    instance: AgentInstance,
    node: Node,
    input: NodeInput,
  ): void {
    this.currentInstance = instance;
    this.currentNode = node;
    this.currentNodeId = node.id;
    this.currentInput = input;
  }

  // ── NodeContext.runAgent ──────────────────────────────

  /**
   * 在 pi 中执行一次 agent 运行。
   *
   * 注入节点上下文消息，切换工具白名单，等待 agent 完成本节点的
   * 工作并通过 __graph_complete__ 上报结果。
   */
  async runAgent(request: AgentRunRequest): Promise<AgentRunResult> {
    const nodeId = this.currentNodeId;
    const instance = this.currentInstance;
    const node = this.currentNode;
    const input = this.currentInput;

    if (!nodeId || !instance || !node || !input) {
      throw new Error(
        "PiNodeContext.runAgent: prepareNodeRun() must be called first",
      );
    }

    // 1. 构造 Promise，等待 agent_end 时 resolve
    const runId = this.nextRunId++;
    this.activeRunId = runId;
    const { promise, resolve, reject } =
      this.createCompletionPromise(runId, nodeId);

    try {
      // 3. 注入节点进入消息（不触发 turn）
      //    skill 文本如果已由上层加载，则作为节点进入消息的一部分
      const entryMsg = buildNodeEntryMessage(
        instance,
        node,
        input,
        request.skill,
      );
      this.pi.sendMessage({
        customType: ENTER_NODE_CUSTOM_TYPE,
        content: entryMsg,
        display: true,
      });

      // 4. 发送实际 prompt（触发 agent 运行）
      this.pi.sendMessage(
        {
          customType: "loop_graph_prompt",
          content: request.prompt,
          display: false,
        },
        { triggerTurn: true },
      );

      // 5. 等待 agent 完成
      const completion = await promise;

      return {
        text: "", // agent 的完整响应文本由下一层处理
        result: completion.result,
      };
    } catch (error) {
      // 如果异常（如 agent 未调用 __graph_complete__），
      // 构造一个 failed 的 completion
      return {
        text: error instanceof Error ? error.message : String(error),
        result: {
          status: "failed",
          reason:
            error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      // 6. 清理状态
      this.activeRunId = 0;
      this.pendingCompletion = null;
    }
  }

  // ── NodeContext.callTool ─────────────────────────────

  /**
   * 在 pi 中直接调用一个工具。
   *
   * MVP 实现：暂不支持。纯代码节点如需调用 pi 工具，
   * 应通过其他机制（如代理到 pi 的工具执行器）。
   */
  async callTool(
    _name: string,
    _input: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error(
      "PiNodeContext.callTool is not yet implemented. " +
        "Pure code nodes that need to call pi tools should use a different mechanism.",
    );
  }

  // ── 内部状态管理 ─────────────────────────────────────

  /** 设置当前正在执行的节点 ID */
  setCurrentNode(nodeId: string): void {
    this.currentNodeId = nodeId;
  }

  /** 当 __graph_complete__ 工具被调用时，由外部调用此方法记录 completion */
  recordCompletion(params: {
    status: "ok" | "failed" | "cancelled";
    result: Record<string, unknown>;
  }): void {
    this.pendingCompletion = {
      nodeId: this.currentNodeId ?? "unknown",
      status: params.status,
      result: params.result,
    };
  }

  /** 清理当前状态（在图运行结束时调用） */
  reset(): void {
    this.currentNodeId = null;
    this.pendingCompletion = null;
  }

  // ── 私有方法 ─────────────────────────────────────────

  /**
   * 由 extension.ts 的 agent_end handler 调用。
   * 检查是否有待处理的 runAgent 调用，如果有则 resolve Promise。
   */
  onAgentEnd(): void {
    if (this.activeRunId === 0) return;

    const resolve = this.activeResolve;
    if (!resolve) return;

    if (this.pendingCompletion) {
      resolve(this.pendingCompletion);
    } else {
      resolve({
        nodeId: this.currentNodeId ?? "unknown",
        status: "failed",
        result: {
          reason: "Agent finished without calling __graph_complete__.",
        },
      });
    }

    this.activeResolve = null;
    this.activeReject = null;
    this.activeRunId = 0;
  }

  private createCompletionPromise(
    runId: number,
    nodeId: string,
  ): {
    promise: Promise<NodeCompletion>;
    resolve: (c: NodeCompletion) => void;
    reject: (e: Error) => void;
  } {
    let resolve!: (c: NodeCompletion) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<NodeCompletion>((res, rej) => {
      const timeout = setTimeout(() => {
        if (this.activeRunId !== runId) return;
        this.activeRunId = 0;
        this.activeResolve = null;
        this.activeReject = null;
        res({
          nodeId,
          status: "failed",
          result: { reason: "Agent run timed out after 5 minutes" },
        });
      }, 5 * 60 * 1000);

      resolve = (c: NodeCompletion) => {
        clearTimeout(timeout);
        this.activeRunId = 0;
        this.activeResolve = null;
        this.activeReject = null;
        res(c);
      };
      reject = (e: Error) => {
        clearTimeout(timeout);
        this.activeRunId = 0;
        this.activeResolve = null;
        this.activeReject = null;
        rej(e);
      };
    });
    this.activeResolve = resolve;
    this.activeReject = reject;
    return { promise, resolve, reject };
  }
}
