// ============================================================
//  GraphRuntime — 图运行时状态机
// ============================================================

import type { AgentInstance, ContextFrame, Graph, Node, NodeInput } from "./type.js";

export interface CallFrame {
  instance: AgentInstance;
  graph: Graph;
  currentNodeId: string | null;
}

export class GraphRuntime {
  callStack: CallFrame[] = [];
  isNodeActive = false;

  /** 当前节点的哨兵标记（customType="loop_graph_boundary" 的 content） */
  nodeMarker: string | null = null;

  currentNode: Node | null = null;
  currentInput: NodeInput | null = null;

  /** 哨兵递增计数，保证同节点重复进入也能区分 */
  private runCounter = 0;

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

  pushGraph(graph: Graph, background: Record<string, unknown>): AgentInstance {
    const instance: AgentInstance = {
      id: crypto.randomUUID(),
      globalGoal: graph.goal,
      background,
      frames: [],
      mechanisms: [],
    };
    this.callStack.push({ instance, graph, currentNodeId: null });
    return instance;
  }

  popGraph(): CallFrame | undefined {
    return this.callStack.pop();
  }

  /** 生成下一个哨兵标记（含随机后缀，保证跨调用唯一） */
  nextMarker(nodeId: string): string {
    this.runCounter++;
    return `__node_boundary__:${nodeId}:${this.runCounter}:${crypto.randomUUID().slice(0, 8)}`;
  }

  enterNode(nodeId: string, marker: string, input: NodeInput): Node {
    const graph = this.topGraph;
    if (!graph) throw new Error("callStack 为空");

    const node = graph.nodes[nodeId];
    if (!node) throw new Error(`节点未找到: ${nodeId}`);

    const top = this.top!;
    top.currentNodeId = nodeId;
    this.currentNode = node;
    this.currentInput = input;
    this.nodeMarker = marker;
    this.isNodeActive = true;

    return node;
  }

  exitNode(frame: ContextFrame): void {
    const instance = this.topInstance;
    if (!instance) throw new Error("callStack 为空");

    instance.frames.push(frame);
    this.isNodeActive = false;
    this.currentNode = null;
    this.currentInput = null;
    this.nodeMarker = null;
  }

  reset(): void {
    this.callStack = [];
    this.isNodeActive = false;
    this.nodeMarker = null;
    this.currentNode = null;
    this.currentInput = null;
    this.runCounter = 0;
  }
}
