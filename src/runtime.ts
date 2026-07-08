// ============================================================
//  GraphRuntime — 图运行时状态机
// ============================================================
//
//  维护调用栈（callStack），每层一个隔离的 AgentInstance。
//  投影只看栈顶——子图自动隔离父图 frames。
//
//  核心状态：
//    callStack          — 调用栈，栈底是顶层图，进子图 push，出 pop
//    isNodeActive       — 当前是否正在执行某个节点
//    nodeStartEntryId   — 当前节点活跃段的起点（leafId）
// ============================================================

import type { AgentInstance, ContextFrame, Graph, Node, NodeInput } from "./type.js";

/** 调用栈的一层 */
export interface CallFrame {
  instance: AgentInstance;
  graph: Graph;
  currentNodeId: string | null;
  nodeStartEntryId: string | null;
}

export class GraphRuntime {
  callStack: CallFrame[] = [];
  isNodeActive = false;

  /** 当前节点的 leafId 锚点（活跃段起点） */
  nodeStartEntryId: string | null = null;

  /** 当前节点信息（供投影使用） */
  currentNode: Node | null = null;
  currentInput: NodeInput | null = null;

  // ── 便捷访问 ──────────────────────────────────────────

  get top(): CallFrame | null {
    return this.callStack.length > 0
      ? this.callStack[this.callStack.length - 1]
      : null;
  }

  get topInstance(): AgentInstance | null {
    return this.top?.instance ?? null;
  }

  get topGraph(): Graph | null {
    return this.top?.graph ?? null;
  }

  get currentNodeId(): string | null {
    return this.top?.currentNodeId ?? null;
  }

  // ── 图 push/pop（顶层 + 子图）────────────────────────

  /** 推入一张图（顶层图或子图） */
  pushGraph(graph: Graph, background: Record<string, unknown>): AgentInstance {
    const instance: AgentInstance = {
      id: crypto.randomUUID(),
      globalGoal: graph.goal,
      background,
      frames: [],
      mechanisms: [],
    };

    this.callStack.push({
      instance,
      graph,
      currentNodeId: null,
      nodeStartEntryId: null,
    });

    return instance;
  }

  /** 弹出当前图（子图 END 或顶层图结束） */
  popGraph(): CallFrame | undefined {
    return this.callStack.pop();
  }

  // ── 节点边界 ──────────────────────────────────────────

  /**
   * 进入节点。记录锚点、设置活跃标志。
   * leafId 由外部传入（ctx.sessionManager.getLeafId()）。
   */
  enterNode(nodeId: string, input: NodeInput, leafId: string): Node {
    const graph = this.topGraph;
    if (!graph) throw new Error("callStack 为空，无法进入节点");

    const node = graph.nodes[nodeId];
    if (!node) throw new Error(`节点未找到: ${nodeId}`);

    const top = this.top!;
    top.currentNodeId = nodeId;
    this.currentNode = node;
    this.currentInput = input;
    this.nodeStartEntryId = leafId;
    this.isNodeActive = true;

    return node;
  }

  /**
   * 离开节点。将 frame push 进栈顶 instance.frames，
   * 更新 nodeStartEntryId 为当前 leafId（下一节点的活跃段起点）。
   */
  exitNode(frame: ContextFrame, leafId: string): void {
    const instance = this.topInstance;
    if (!instance) throw new Error("callStack 为空，无法退出节点");

    instance.frames.push(frame);
    this.nodeStartEntryId = leafId;
    this.isNodeActive = false;
    this.currentNode = null;
    this.currentInput = null;
  }

  // ── 子图专用 ──────────────────────────────────────────

  /**
   * 子图 END 后，将其整段结果归约为一帧并 push 进父 instance.frames。
   * 调用此方法前需先 popGraph() 回到父层。
   */
  foldSubgraphResult(
    parentGraphNodeId: string,
    childResult: { status: "ok" | "failed" | "cancelled"; result: Record<string, unknown> },
    summary: string,
  ): void {
    const parentInstance = this.topInstance;
    if (!parentInstance) throw new Error("子图 pop 后 callStack 为空");

    parentInstance.frames.push({
      nodeId: parentGraphNodeId,
      status: childResult.status,
      summary,
      result: childResult.result,
    });
  }

  /** 清理（图运行结束时） */
  reset(): void {
    this.callStack = [];
    this.isNodeActive = false;
    this.nodeStartEntryId = null;
    this.currentNode = null;
    this.currentInput = null;
  }
}
