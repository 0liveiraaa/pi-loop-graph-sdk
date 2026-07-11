// ============================================================
//  GraphRuntime — 图运行时状态机
// ============================================================

import type { AgentInstance, ContextFrame, Graph, Node, NodeInput } from "./type.js";

export interface CallFrame {
  instance: AgentInstance;
  graph: Graph;
  currentNodeId: string | null;
}

export interface NodeScopeDescriptor {
  protocol: 2;
  graphRunId: string;
  instanceId: string;
  scopeId: string;
  graphId: string;
  nodeId: string;
  visit: number;
  depth: number;
}

export class GraphRuntime {
  callStack: CallFrame[] = [];
  isNodeActive = false;

  /** 当前节点的语义作用域。details 用于匹配，不依赖消息正文。 */
  currentScope: NodeScopeDescriptor | null = null;

  currentNode: Node | null = null;
  currentInput: NodeInput | null = null;

  readonly graphRunId = crypto.randomUUID();
  private nodeVisits = new Map<string, number>();

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
      mechanisms: graph.mechanisms ?? [],
      scratch: {},
    };
    this.callStack.push({ instance, graph, currentNodeId: null });
    return instance;
  }

  popGraph(): CallFrame | undefined {
    return this.callStack.pop();
  }

  nextScope(nodeId: string): NodeScopeDescriptor {
    const top = this.top;
    if (!top) throw new Error("callStack 为空");
    const visit = (this.nodeVisits.get(nodeId) ?? 0) + 1;
    this.nodeVisits.set(nodeId, visit);
    return {
      protocol: 2,
      graphRunId: this.graphRunId,
      instanceId: top.instance.id,
      scopeId: crypto.randomUUID(),
      graphId: top.graph.id,
      nodeId,
      visit,
      depth: this.callStack.length,
    };
  }

  enterNode(nodeId: string, scope: NodeScopeDescriptor, input: NodeInput): Node {
    const graph = this.topGraph;
    if (!graph) throw new Error("callStack 为空");

    const node = graph.nodes[nodeId];
    if (!node) throw new Error(`节点未找到: ${nodeId}`);

    const top = this.top!;
    top.currentNodeId = nodeId;
    this.currentNode = node;
    this.currentInput = input;
    this.currentScope = scope;
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
    this.currentScope = null;
  }

  reset(): void {
    this.callStack = [];
    this.isNodeActive = false;
    this.currentScope = null;
    this.currentNode = null;
    this.currentInput = null;
    this.nodeVisits.clear();
  }
}
