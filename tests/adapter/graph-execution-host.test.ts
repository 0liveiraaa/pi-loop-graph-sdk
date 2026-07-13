import { describe, expect, it, vi } from "vitest";
import type { Graph, GraphRunRequest, GraphRunResult } from "../../src/type.js";
import {
  IsolatedSessionGraphHost,
  normalizeGraphRunRequest,
  type IsolatedGraphSession,
} from "../../src/adapter/graph-execution-host.js";

const graph = { id: "g" } as Graph;
const request = (): GraphRunRequest => ({
  background: { input: "hello" },
  invocationKind: "tool",
  boundary: "delegate",
});

describe("normalizeGraphRunRequest", () => {
  it("兼容旧 subgraph，并默认映射为 graph-node + call", () => {
    expect(normalizeGraphRunRequest({
      background: { value: 1 },
      invocationKind: "subgraph",
    })).toMatchObject({
      background: { value: 1 },
      invocationKind: "graph-node",
      boundary: "call",
    });
  });

  it("command/tool 默认 delegate，api/graph-node 默认 call", () => {
    expect(normalizeGraphRunRequest({ background: {}, invocationKind: "command" }).boundary).toBe("delegate");
    expect(normalizeGraphRunRequest({ background: {}, invocationKind: "tool" }).boundary).toBe("delegate");
    expect(normalizeGraphRunRequest({ background: {}, invocationKind: "api" }).boundary).toBe("call");
    expect(normalizeGraphRunRequest({ background: {}, invocationKind: "graph-node" }).boundary).toBe("call");
  });

  it("保留显式 boundary 与 signal", () => {
    const controller = new AbortController();
    const normalized = normalizeGraphRunRequest({
      background: {},
      invocationKind: "api",
      boundary: "compose",
      signal: controller.signal,
    });
    expect(normalized.boundary).toBe("compose");
    expect(normalized.signal).toBe(controller.signal);
  });

  it("未知 invocationKind 明确报错，不静默降级为 api", () => {
    expect(() => normalizeGraphRunRequest({
      background: {},
      invocationKind: "typo",
    })).toThrow(/未知 GraphInvocationKind/);
  });
});

function fakeSession(result?: Partial<GraphRunResult>): IsolatedGraphSession & {
  run: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn().mockResolvedValue({
      graphId: "g",
      status: "ok",
      result: { value: 1 },
      steps: 1,
      ...result,
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

describe("IsolatedSessionGraphHost", () => {
  it("通过独立 session 执行图并返回 GraphRunResult", async () => {
    const session = fakeSession();
    const createSession = vi.fn().mockResolvedValue(session);
    const host = new IsolatedSessionGraphHost({ createSession });

    await expect(host.run(graph, request())).resolves.toEqual({
      graphId: "g",
      status: "ok",
      result: { value: 1 },
      steps: 1,
    });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      background: { input: "hello" },
      invocationKind: "tool",
    }));
    expect(session.run).toHaveBeenCalledWith(graph, expect.objectContaining({
      background: { input: "hello" },
    }));
  });

  it("dispose 固定先 abort 再 dispose，且幂等", async () => {
    const order: string[] = [];
    const session = fakeSession();
    session.abort.mockImplementation(async () => { order.push("abort"); });
    session.dispose.mockImplementation(() => { order.push("dispose"); });
    const host = new IsolatedSessionGraphHost({
      createSession: vi.fn().mockResolvedValue(session),
    });

    await host.run(graph, request());
    await Promise.all([host.dispose(), host.dispose()]);

    expect(order).toEqual(["abort", "dispose"]);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose 后拒绝再次 run", async () => {
    const host = new IsolatedSessionGraphHost({
      createSession: vi.fn().mockResolvedValue(fakeSession()),
    });
    await host.dispose();

    await expect(host.run(graph, request())).rejects.toThrow("已释放");
  });

  it("createSession 进行中调用 dispose 会等待创建完成并清理一次", async () => {
    let resolveSession!: (session: IsolatedGraphSession) => void;
    const session = fakeSession();
    const host = new IsolatedSessionGraphHost({
      createSession: () => new Promise<IsolatedGraphSession>((resolve) => {
        resolveSession = resolve;
      }),
    });

    const running = host.run(graph, request());
    await vi.waitFor(() => expect(resolveSession).toBeDefined());
    const disposing = host.dispose();
    resolveSession(session);

    await expect(disposing).resolves.toBeUndefined();
    await expect(running).rejects.toThrow("已释放");
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("已 abort 的 signal 不创建子会话", async () => {
    const controller = new AbortController();
    controller.abort();
    const createSession = vi.fn();
    const host = new IsolatedSessionGraphHost({ createSession });

    await expect(host.run(graph, { ...request(), signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("运行期间 outer abort 会转发给子会话", async () => {
    const controller = new AbortController();
    let resolveRun!: (value: GraphRunResult) => void;
    const session = fakeSession();
    session.run.mockImplementation(() => new Promise<GraphRunResult>((resolve) => {
      resolveRun = resolve;
    }));
    const host = new IsolatedSessionGraphHost({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const running = host.run(graph, { ...request(), signal: controller.signal });
    await vi.waitFor(() => expect(session.run).toHaveBeenCalled());
    controller.abort();
    await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1));
    resolveRun({ graphId: "g", status: "cancelled", result: {}, steps: 0 });

    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    await host.dispose();
  });

  it("同一 host 拒绝并发 run", async () => {
    let resolveRun!: (value: GraphRunResult) => void;
    const session = fakeSession();
    session.run.mockImplementation(() => new Promise<GraphRunResult>((resolve) => {
      resolveRun = resolve;
    }));
    const host = new IsolatedSessionGraphHost({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const first = host.run(graph, request());
    await vi.waitFor(() => expect(session.run).toHaveBeenCalled());
    await expect(host.run(graph, request())).rejects.toThrow("并发调用必须创建独立 host");
    resolveRun({ graphId: "g", status: "ok", result: {}, steps: 1 });
    await first;
    await host.dispose();
  });

  it("abort 抛错时仍然执行 dispose", async () => {
    const session = fakeSession();
    session.abort.mockRejectedValue(new Error("abort failed"));
    const host = new IsolatedSessionGraphHost({
      createSession: vi.fn().mockResolvedValue(session),
    });
    await host.run(graph, request());

    await expect(host.dispose()).rejects.toThrow("abort failed");
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("abort 和 dispose 同时抛错时保留两边信息", async () => {
    const session = fakeSession();
    session.abort.mockRejectedValue(new Error("abort failed"));
    session.dispose.mockImplementation(() => { throw new Error("dispose failed"); });
    const host = new IsolatedSessionGraphHost({
      createSession: vi.fn().mockResolvedValue(session),
    });
    await host.run(graph, request());

    // 主错误应为 abort 错误
    let thrown: any;
    try {
      await host.dispose();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).toBe("abort failed");
    // dispose 错误作为 suppressed 附加
    expect(thrown.suppressed).toBeDefined();
    expect(thrown.suppressed.message).toBe("dispose failed");
  });
});
