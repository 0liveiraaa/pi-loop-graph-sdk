// ============================================================
//  GraphRuntime — 图运行时状态机
// ============================================================

import type { AgentInstance, ContextFrame, Graph, Mechanism, Node, NodeCompletion, NodeInput } from "./type.js";

export interface CallFrame {
  instance: AgentInstance;
  graph: Graph;
  /** 图调用的上下文边界。 */
  boundary: "root" | "call" | "compose";
  /** compose 复用父 Instance，但 child Graph 的目标/机制只在此调用帧生效。 */
  localGoal: string;
  localMechanisms: readonly Mechanism[];
  callBackground: Record<string, unknown>;
  parentNodeId?: string;
  /** 每个调用帧独立计数，避免同名子图节点污染 visit。 */
  nodeVisits: Map<string, number>;
  currentNodeId: string | null;
  /**
   * 节点瞬态状态也归属调用帧。子图返回时必须恢复仍在执行的父 graph node，
   * 否则 context 投影会错误地认为父节点已经结束。
   */
  activeNode: Node | null;
  activeInput: NodeInput | null;
  activeScope: NodeScopeDescriptor | null;
  isNodeActive: boolean;
  /** 已被最近一次 pi compaction 原生上下文取代的 frame 前缀长度。 */
  projectedFrameBase: number;
}

/** compose 调用在父 frames 上建立的受 Runtime 管理的临时区间。 */
export interface FrameSegmentScope {
  id: string;
  graphId: string;
  parentNodeId: string;
  instanceId: string;
  baseIndex: number;
  depth: number;
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
  /** 当前 graph run 已发生的 compaction 次数，仅用于诊断和 checkpoint 观测。 */
  compactionGeneration = 0;
  /**
   * 共享 call/compose 活跃期间异常收到 session_compact 时设为 true。
   * 此后本 session 投影中将持续过滤 compactionSummary，优先保证不泄漏。
   */
  compactionBoundaryViolated = false;
  /** Runtime 控制平面的 frame → NodeScope 对齐表，不进入开发者 frame/LLM。 */
  private readonly frameScopes = new Map<string, NodeScopeDescriptor[]>();

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

  pushGraph(
    graph: Graph,
    background: Record<string, unknown>,
    boundary: CallFrame["boundary"] = "root",
    sharedInstance?: AgentInstance,
    parentNodeId?: string,
  ): AgentInstance {
    const instance = sharedInstance ?? {
      id: crypto.randomUUID(),
      globalGoal: graph.goal,
      background,
      frames: [],
      mechanisms: graph.mechanisms ?? [],
      scratch: {},
    };
    if (!this.frameScopes.has(instance.id)) this.frameScopes.set(instance.id, []);
    this.callStack.push({
      instance,
      graph,
      boundary,
      localGoal: graph.goal,
      // root/call 已写入 instance；compose 只在子调用帧叠加，退出即消失。
      localMechanisms: sharedInstance ? (graph.mechanisms ?? []) : [],
      callBackground: background,
      parentNodeId,
      nodeVisits: new Map(),
      currentNodeId: null,
      activeNode: null,
      activeInput: null,
      activeScope: null,
      isNodeActive: false,
      projectedFrameBase: 0,
    });
    return instance;
  }

  popGraph(): CallFrame | undefined {
    const popped = this.callStack.pop();
    this.restoreActiveNodeFromTop();
    return popped;
  }

  beginFrameSegment(graphId: string, parentNodeId: string): FrameSegmentScope {
    const instance = this.topInstance;
    if (!instance) throw new Error("callStack 为空");
    return {
      id: crypto.randomUUID(),
      graphId,
      parentNodeId,
      instanceId: instance.id,
      baseIndex: instance.frames.length,
      depth: this.callStack.length + 1,
    };
  }

  readFrameSegment(scope: FrameSegmentScope): readonly ContextFrame[] {
    const instance = this.assertSegmentOwner(scope);
    // fold 只能看到独立快照。除顶层 frame 外也复制并冻结 result 的可变数据，
    // 以免 folder 修改嵌套字段时反向影响 live frames。
    return Object.freeze(instance.frames.slice(scope.baseIndex).map(snapshotFrame));
  }

  rollbackFrameSegment(scope: FrameSegmentScope): void {
    const instance = this.assertSegmentOwner(scope);
    instance.frames.splice(scope.baseIndex);
    this.frameScopes.get(instance.id)?.splice(scope.baseIndex);
  }

  closeFrameSegment(scope: FrameSegmentScope, completion: NodeCompletion): NodeCompletion {
    this.rollbackFrameSegment(scope);
    return completion;
  }

  nextScope(nodeId: string): NodeScopeDescriptor {
    const top = this.top;
    if (!top) throw new Error("callStack 为空");
    const visit = (top.nodeVisits.get(nodeId) ?? 0) + 1;
    top.nodeVisits.set(nodeId, visit);
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
    top.activeNode = node;
    top.activeInput = input;
    top.activeScope = scope;
    top.isNodeActive = true;

    return node;
  }

  exitNode(frame: ContextFrame): void {
    const instance = this.topInstance;
    if (!instance) throw new Error("callStack 为空");

    instance.frames.push(frame);
    if (this.currentScope) this.frameScopes.get(instance.id)?.push(this.currentScope);
    this.isNodeActive = false;
    this.currentNode = null;
    this.currentInput = null;
    this.currentScope = null;
    const top = this.top;
    if (top) {
      top.activeNode = null;
      top.activeInput = null;
      top.activeScope = null;
      top.isNodeActive = false;
    }
  }

  /**
   * 记录一次 session compaction。NodeScope 的身份（scopeId）不变。
   * Runtime 只推进 projectedFrameBase；pi 原生 summary 与 recent messages
   * 是压缩历史的权威替代，SDK 不重发 scope，也不遮挡 summary。
   */
  recordCompaction(projectedFrameBase?: number): number {
    this.compactionGeneration += 1;
    const top = this.top;
    if (top) {
      const nextBase = projectedFrameBase ?? top.instance.frames.length;
      top.projectedFrameBase = Math.max(
        top.projectedFrameBase,
        Math.min(nextBase, top.instance.frames.length),
      );
    }
    return this.compactionGeneration;
  }

  /** 当前 callStack 是否存在嵌套 call/compose（非 root-only）。 */
  get hasActiveSharedCall(): boolean {
    return this.callStack.some(
      (frame) => frame.boundary === "call" || frame.boundary === "compose",
    );
  }

  /** 共享调用边界被 compaction 切断后，继续运行会泄漏无法归属的 transcript。 */
  assertNoCompactionBoundaryViolation(): void {
    if (this.compactionBoundaryViolated) {
      throw new Error("compaction 边界违规：共享 call/compose 已终止，当前 Session 上下文已进入 fail-closed 状态");
    }
  }

  get completedFrameScopes(): readonly NodeScopeDescriptor[] {
    const instance = this.topInstance;
    return instance ? (this.frameScopes.get(instance.id) ?? []) : [];
  }

  /** 只返回最近一次 compaction 后新生长、仍需单独投影的开发者 frames。 */
  get projectedFrames(): ContextFrame[] {
    const top = this.top;
    return top ? top.instance.frames.slice(top.projectedFrameBase) : [];
  }

  reset(): void {
    this.callStack = [];
    this.isNodeActive = false;
    this.currentScope = null;
    this.currentNode = null;
    this.currentInput = null;
    this.compactionGeneration = 0;
    this.compactionBoundaryViolated = false;
    this.frameScopes.clear();
  }

  private assertSegmentOwner(scope: FrameSegmentScope): AgentInstance {
    const instance = this.topInstance;
    if (!instance || instance.id !== scope.instanceId) {
      throw new Error("FrameSegmentScope 不属于当前调用帧");
    }
    if (scope.baseIndex > instance.frames.length) {
      throw new Error("FrameSegmentScope 的 baseIndex 无效");
    }
    return instance;
  }

  private restoreActiveNodeFromTop(): void {
    const top = this.top;
    this.currentNode = top?.activeNode ?? null;
    this.currentInput = top?.activeInput ?? null;
    this.currentScope = top?.activeScope ?? null;
    this.isNodeActive = top?.isNodeActive ?? false;
  }
}

/** 复制并冻结 compose fold 可见的帧，不向其暴露 live 引用。 */
function snapshotFrame(frame: ContextFrame): ContextFrame {
  return Object.freeze(snapshotValue(frame) as ContextFrame);
}

/**
 * NodeCompletion.result 是数据对象。这里不用 structuredClone：业务结果可包含
 * 无法被它复制的值（例如函数），而函数本身不可通过普通属性写入改变帧数据。
 * 对常见的对象/数组/Map/Set/Date 递归复制，随后冻结普通对象和数组。
 */
function snapshotValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached) return cached;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(snapshotValue(item, seen));
    return Object.freeze(copy);
  }
  if (value instanceof Date) return Object.freeze(new Date(value.getTime()));
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, item] of value) copy.set(snapshotValue(key, seen), snapshotValue(item, seen));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const item of value) copy.add(snapshotValue(item, seen));
    return copy;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = snapshotValue(item, seen);
  }
  return Object.freeze(copy);
}
