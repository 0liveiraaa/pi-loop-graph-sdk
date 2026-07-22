import type { TSchema } from "typebox";
import type { Graph, SchemaValue } from "../core/graph.js";
import type { InvocationLimits } from "../core/limits.js";
import type { GraphRunResult } from "../core/result.js";
import type { RecordingMode } from "../core/result.js";
import { GraphRuntime, type GraphRuntimeHost } from "../runtime/graph-runtime.js";
import { RuntimeEventBus } from "../runtime/event-bus.js";
import { FileRunStore, type RunStore } from "../replay/store.js";
import { Recorder } from "../replay/recorder.js";
import type { PricingResolver } from "../replay/events.js";

export interface GraphHostRunOptions {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<InvocationLimits>;
  readonly maxSteps?: number;
  readonly recording?: RecordingMode;
  readonly recordingRequired?: boolean;
}

export interface GraphHost {
  execute<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
    graph: Graph<TInputSchema, TOutputSchema>,
    input: SchemaValue<TInputSchema>,
    options?: GraphHostRunOptions,
  ): Promise<GraphRunResult<SchemaValue<TOutputSchema>>>;
  dispose(): Promise<void>;
}

export interface CreateGraphHostOptions {
  readonly runtime?: GraphRuntimeHost;
  readonly dispose?: () => void | Promise<void>;
  readonly recording?: RecordingMode;
  readonly recordingRequired?: boolean;
  readonly runStore?: RunStore;
  readonly artifactThresholdBytes?: number;
  readonly pricingResolver?: PricingResolver;
}

/** Owns one Core Runtime execution lane. Concurrent roots require separate hosts. */
export function createGraphHost(options: CreateGraphHostOptions = {}): GraphHost {
  const eventBus = options.runtime?.eventBus ?? new RuntimeEventBus();
  const runtime = new GraphRuntime({ ...options.runtime, eventBus });
  const runStore = options.runStore ?? new FileRunStore();
  let running = false;
  let activeRun: Promise<GraphRunResult<any>> | undefined;
  let activeController: AbortController | undefined;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  return {
    async execute(graph, input, runOptions = {}) {
      if (disposed) throw new Error("GraphHost 已释放");
      if (running) throw new Error("GraphHost 已有 Root Run 正在执行；并发运行必须创建独立 Host");
      running = true;
      const controller = new AbortController();
      activeController = controller;
      const onAbort = () => controller.abort(runOptions.signal?.reason);
      if (runOptions.signal?.aborted) onAbort();
      else runOptions.signal?.addEventListener("abort", onAbort, { once: true });
      const recording = runOptions.recording ?? options.recording ?? "replay";
      const recordingRequired = runOptions.recordingRequired ?? options.recordingRequired ?? false;
      const recorder = recording === "off" ? undefined : new Recorder({
        mode: recording,
        store: runStore,
        artifactThresholdBytes: options.artifactThresholdBytes,
        pricingResolver: options.pricingResolver,
      });
      recorder?.attach(eventBus);
      const execution: Promise<GraphRunResult<any>> = (async () => {
      try {
        const result = await runtime.execute(graph, input, { ...runOptions, signal: controller.signal });
        if (!recorder) return { ...result, replay: Object.freeze({ mode: "off", status: "off" }) };
        const finalized = await recorder.finalize(result);
        if (recordingRequired && finalized.replay.status !== "complete") {
          return {
            rootRunId: result.rootRunId,
            graphId: result.graphId,
            graphVersion: result.graphVersion,
            steps: result.steps,
            durationMs: result.durationMs,
            replay: finalized.replay,
            status: "failed" as const,
            failure: {
              code: "persistence-failed",
              phase: "host",
              message: finalized.replay.issues?.join("; ") ?? "Replay recording failed",
              retryable: true,
            },
          } as GraphRunResult<any>;
        }
        return { ...result, replay: finalized.replay };
      } finally {
        runOptions.signal?.removeEventListener("abort", onAbort);
        running = false;
        activeController = undefined;
      }
      })();
      activeRun = execution;
      try {
        return await execution;
      } finally {
        if (activeRun === execution) activeRun = undefined;
      }
    },
    async dispose() {
      if (disposing) return disposing;
      disposed = true;
      activeController?.abort(new Error("GraphHost disposed"));
      disposing = (async () => {
        await activeRun?.catch(() => undefined);
        await options.dispose?.();
      })();
      return disposing;
    },
  };
}

export interface ExecuteIsolatedGraphOptions<TInput> extends GraphHostRunOptions {
  readonly input: TInput;
  readonly createHost: () => GraphHost | Promise<GraphHost>;
}

/** Creates, runs and always disposes a one-shot host. */
export async function executeIsolatedGraph<
  TInputSchema extends TSchema,
  TOutputSchema extends TSchema,
>(
  graph: Graph<TInputSchema, TOutputSchema>,
  options: ExecuteIsolatedGraphOptions<SchemaValue<TInputSchema>>,
): Promise<GraphRunResult<SchemaValue<TOutputSchema>>> {
  const host = await options.createHost();
  let runError: unknown;
  try {
    return await host.execute(graph, options.input, options);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await host.dispose();
    } catch (disposeError) {
      if (runError && typeof runError === "object") (runError as { suppressed?: unknown }).suppressed = disposeError;
      else throw disposeError;
    }
  }
}
