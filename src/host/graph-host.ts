import type { TSchema } from "typebox";
import type { Graph, SchemaValue } from "../core/graph.js";
import type { InvocationLimits } from "../core/limits.js";
import type { GraphRunResult } from "../core/result.js";
import { GraphRuntime, type GraphRuntimeHost } from "../runtime/graph-runtime.js";

export interface GraphHostRunOptions {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<InvocationLimits>;
  readonly maxSteps?: number;
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
}

/** Owns one Core Runtime execution lane. Concurrent roots require separate hosts. */
export function createGraphHost(options: CreateGraphHostOptions = {}): GraphHost {
  const runtime = new GraphRuntime(options.runtime);
  let running = false;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  return {
    async execute(graph, input, runOptions = {}) {
      if (disposed) throw new Error("GraphHost 已释放");
      if (running) throw new Error("GraphHost 已有 Root Run 正在执行；并发运行必须创建独立 Host");
      running = true;
      try {
        return await runtime.execute(graph, input, runOptions);
      } finally {
        running = false;
      }
    },
    async dispose() {
      if (disposing) return disposing;
      disposed = true;
      disposing = Promise.resolve(options.dispose?.()).then(() => undefined);
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
