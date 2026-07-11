import type {
  Graph,
  GraphInvocationBoundary,
  GraphInvocationKind,
  GraphRunRequest,
  GraphRunResult,
} from "../type.js";

/** 为旧调用（仅有 invocationKind，无 boundary）填补默认值。
 *  旧 `"subgraph"` → `graph-node` + `call`。 */
export function normalizeGraphRunRequest(
  partial: {
    background: Record<string, unknown>;
    invocationKind: string;
    boundary?: GraphInvocationBoundary;
    signal?: AbortSignal;
  },
): GraphRunRequest {
  let kind: GraphInvocationKind;
  if (partial.invocationKind === "subgraph") {
    kind = "graph-node";
  } else if (
    partial.invocationKind === "command" ||
    partial.invocationKind === "tool" ||
    partial.invocationKind === "graph-node" ||
    partial.invocationKind === "api"
  ) {
    kind = partial.invocationKind;
  } else {
    throw new Error(`未知 GraphInvocationKind: ${partial.invocationKind}`);
  }
  const boundary = partial.boundary ?? (kind === "tool" || kind === "command" ? "delegate" : "call");
  return { background: partial.background, invocationKind: kind, boundary, signal: partial.signal };
}

/** 图执行载体。不同实现可以承载进程内子会话、子进程或远程 worker。 */
export interface GraphExecutionHost {
  run(graph: Graph, request: GraphRunRequest): Promise<GraphRunResult>;
  dispose(): Promise<void>;
}

/**
 * IsolatedSessionGraphHost 使用的最小子会话句柄。
 *
 * sessionFactory 后续由 pi adapter 通过 createAgentSession() 构造，并在
 * runtime-only extension factory 中绑定 executeGraph。Host 本身只负责严格的
 * run/abort/dispose 生命周期，不依赖 pi 的私有 API。
 */
export interface IsolatedGraphSession {
  run(graph: Graph, request: GraphRunRequest): Promise<GraphRunResult>;
  abort(): Promise<void>;
  dispose(): void;
}

export type IsolatedGraphSessionFactory = (
  request: GraphRunRequest,
) => Promise<IsolatedGraphSession>;

export interface IsolatedSessionGraphHostOptions {
  createSession: IsolatedGraphSessionFactory;
}

/**
 * 为一次 graph-tool 调用持有一个独立子 AgentSession 的生命周期外壳。
 *
 * 契约：
 * - 一个 host 同时只运行一张图；并发调用应创建多个 host。
 * - outer AbortSignal 会转发给子会话 abort()。
 * - dispose 顺序固定为 abort() -> dispose()。
 * - dispose 后拒绝 run()，弥补 AgentSession.dispose() 仍允许 prompt 的行为。
 */
export class IsolatedSessionGraphHost implements GraphExecutionHost {
  private session: IsolatedGraphSession | null = null;
  private sessionPromise: Promise<IsolatedGraphSession> | null = null;
  private cleanedSession: IsolatedGraphSession | null = null;
  private disposed = false;
  private running = false;
  private disposing: Promise<void> | null = null;

  constructor(private readonly options: IsolatedSessionGraphHostOptions) {}

  async run(graph: Graph, request: GraphRunRequest): Promise<GraphRunResult> {
    this.assertUsable();
    if (this.running) {
      throw new Error("IsolatedSessionGraphHost 已有图正在运行；并发调用必须创建独立 host");
    }
    if (request.signal?.aborted) throw createAbortError();

    this.running = true;
    try {
      const sessionPromise = this.options.createSession(request);
      this.sessionPromise = sessionPromise;
      let session: IsolatedGraphSession;
      try {
        session = await sessionPromise;
      } finally {
        if (this.sessionPromise === sessionPromise) this.sessionPromise = null;
      }

      // createSession 期间也可能收到 dispose/abort。
      if (this.disposed || request.signal?.aborted) {
        await this.cleanupSession(session);
        if (request.signal?.aborted) throw createAbortError();
        throw new Error("IsolatedSessionGraphHost 已释放");
      }

      this.session = session;
      const onAbort = () => {
        void session.abort().catch(() => undefined);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        return await session.run(graph, request);
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      this.running = false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;

    this.disposing = (async () => {
      const pendingSession = this.sessionPromise;
      const session = this.session;
      this.session = null;
      if (session) {
        await this.cleanupSession(session);
        return;
      }
      if (pendingSession) {
        try {
          await this.cleanupSession(await pendingSession);
        } catch {
          // createSession 自身失败时没有可清理的 session。
        }
      }
    })();

    return this.disposing;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("IsolatedSessionGraphHost 已释放");
  }

  private async cleanupSession(session: IsolatedGraphSession): Promise<void> {
    if (this.cleanedSession === session) return;
    this.cleanedSession = session;
    await abortThenDispose(session);
  }
}

async function abortThenDispose(session: IsolatedGraphSession): Promise<void> {
  let abortError: unknown = undefined;
  try {
    await session.abort();
  } catch (e) {
    abortError = e;
  }
  try {
    session.dispose();
  } catch (disposeError) {
    if (abortError != null) {
      (abortError as any).suppressed = disposeError;
    }
    throw abortError ?? disposeError;
  }
  if (abortError != null) throw abortError;
}

function createAbortError(): Error {
  const error = new Error("Graph execution aborted");
  error.name = "AbortError";
  return error;
}
