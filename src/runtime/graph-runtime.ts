import type { TSchema } from "typebox";
import type {
  AgentNodeDefinition,
  AgentRunRequest,
  CodeNodeDefinition,
  Connection,
  Graph,
  GraphNodeDefinition,
  GraphRef,
  NodeCompletion,
  NodeDefinition,
  SchemaValue,
} from "../core/graph.js";
import type { InvocationLimits } from "../core/limits.js";
import { resolveInvocationLimits } from "../core/limits.js";
import type { GraphFailure, GraphRunResult } from "../core/result.js";
import type { JsonValue } from "../core/json.js";
import type { Mechanism, MechanismCompletionDecision } from "../core/mechanism.js";
import { ContextState, type ContextSnapshot } from "../core/context.js";
import { checkJsonSchemaValue } from "../core/schema.js";
import type { ResolvedSkillView, SkillRef } from "../core/skill.js";
import type { GraphCatalog } from "../host/graph-catalog.js";
import type { HostBaseline } from "../host/baseline.js";
import { resolveHostBaseline } from "../host/baseline.js";
import type { SkillCatalog } from "../host/skill-catalog.js";
import {
  CapabilityPreflightError,
  preflightGraphCapabilities,
  resolveNodeToolNames,
} from "../host/preflight.js";
import {
  RUNTIME_PROTOCOL_TOOL_NAME,
  selectNodeToolNames,
  type ToolCatalog,
  type ToolImplementation,
  type UnsafeToolResolver,
} from "../host/tool-catalog.js";
import { RuntimeEventBus } from "./event-bus.js";
import {
  InvocationBudget,
  InvocationBudgetExceededError,
} from "./invocation-budget.js";
import { MechanismRuntime, MechanismRuntimeError, type MechanismChain, type MechanismRuntimeOptions } from "./mechanism-runtime.js";
import type { CheckpointStore } from "../replay/store.js";
import { decodeCheckpoint, encodeCheckpoint, type CheckpointNodeBoundary } from "../replay/checkpoint.js";

export type InvocationBoundary = "root" | "call" | "compose" | "delegate";

export interface RootRunState {
  readonly rootRunId: string;
  readonly startedAt: number;
  readonly budget: InvocationBudget;
  readonly signal?: AbortSignal;
  readonly baseline: HostBaseline;
}

export interface GraphInvocationState {
  readonly graphInvocationId: string;
  readonly rootRunId: string;
  readonly parentGraphInvocationId?: string;
  readonly graph: GraphRef;
  readonly boundary: InvocationBoundary;
  readonly depth: number;
  readonly frames: JsonValue[];
  readonly frameRevision: { value: number };
}

export interface NodeVisitState {
  readonly nodeVisitId: string;
  readonly rootRunId: string;
  readonly graphInvocationId: string;
  readonly stageId: string;
  readonly visit: number;
}

export interface AgentRunState {
  readonly agentRunId: string;
  readonly rootRunId: string;
  readonly graphInvocationId: string;
  readonly nodeVisitId: string;
  readonly index: number;
}

export interface AgentExecutionContext {
  readonly root: RootRunState;
  readonly invocation: GraphInvocationState;
  readonly nodeVisit: NodeVisitState;
  readonly agentRun: AgentRunState;
  readonly tools: readonly ToolImplementation[];
  readonly skills: readonly ResolvedSkillView[];
  readonly baseline: HostBaseline;
  readonly snapshot: ContextSnapshot;
  readonly mechanisms?: MechanismChain;
  validateNodeCompletion(result: JsonValue): Promise<{ readonly valid: boolean; readonly reason?: string }>;
  validateRouteStructure(result: JsonValue): Promise<{ readonly valid: boolean; readonly reason?: string }>;
  validateMechanismCompletion(result: JsonValue): Promise<MechanismCompletionDecision>;
  validateAgentChoice(result: JsonValue): Promise<{ readonly valid: boolean; readonly reason?: string }>;
  invokeGraph(
    ref: GraphRef,
    input: JsonValue,
    boundary?: Exclude<InvocationBoundary, "root">,
  ): Promise<InvocationOutcome>;
}

export interface DelegateGraphRequest {
  readonly graph: Graph;
  readonly input: JsonValue;
  readonly root: RootRunState;
  readonly parentInvocation: GraphInvocationState;
  readonly execute: () => Promise<InvocationOutcome>;
}

export interface InvocationAgentHost {
  runAgent?: GraphRuntimeHost["runAgent"];
  runAgentFromCode?: GraphRuntimeHost["runAgentFromCode"];
  dispose(): void | Promise<void>;
}

export interface InvocationAgentHostRequest {
  readonly root: RootRunState;
  readonly invocation: GraphInvocationState;
}

export interface GraphRuntimeHost {
  readonly catalog?: GraphCatalog;
  readonly eventBus?: RuntimeEventBus;
  readonly toolCatalog?: ToolCatalog;
  readonly skillCatalog?: SkillCatalog;
  readonly unsafeToolResolver?: UnsafeToolResolver;
  readonly protocolTools?: readonly ToolImplementation[];
  readonly baseline?: HostBaseline;
  /** Maximum UTF-8 bytes of canonical sticky context allowed before an Agent Run. */
  readonly maxStickyContextBytes?: number;
  readonly mechanisms?: readonly Mechanism[];
  readonly mechanismRuntime?: MechanismRuntimeOptions;
  /** Store for persisting node-boundary checkpoints. */
  readonly checkpointStore?: CheckpointStore;
  runAgent?(
    node: AgentNodeDefinition,
    input: JsonValue,
    context: AgentExecutionContext,
  ): Promise<JsonValue>;
  runAgentFromCode?(
    request: AgentRunRequest,
    node: CodeNodeDefinition,
    context: AgentExecutionContext,
  ): Promise<JsonValue>;
  resolveGraph?(ref: GraphRef): Graph | undefined;
  delegateGraph?(request: DelegateGraphRequest): Promise<InvocationOutcome>;
  /** Creates an Agent execution lane for one call/compose Graph Invocation. */
  createInvocationAgentHost?(request: InvocationAgentHostRequest): Promise<InvocationAgentHost>;
}

export interface GraphExecutionOptions {
  readonly limits?: Partial<InvocationLimits>;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
}

export interface InvocationOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  readonly output?: JsonValue;
  readonly failure?: GraphFailure;
}

interface InvocationRequest {
  readonly graph: Graph;
  readonly input: JsonValue;
  readonly boundary: InvocationBoundary;
  readonly root: RootRunState;
  readonly parent?: GraphInvocationState;
  readonly sharedFrames?: JsonValue[];
  readonly sharedFrameRevision?: { value: number };
  readonly maxSteps: number;
  readonly mechanismRuntime: MechanismRuntime;
  readonly hostMechanisms: MechanismChain;
}

class RuntimeFailure extends Error {
  constructor(readonly failure: GraphFailure) {
    super(failure.message);
    this.name = "RuntimeFailure";
  }
}

export class GraphRuntime {
  readonly eventBus: RuntimeEventBus;
  private readonly mechanismRuns = new WeakMap<RootRunState, { runtime: MechanismRuntime; host: MechanismChain }>();
  private readonly invocationAgentHosts = new Map<string, InvocationAgentHost>();
  private readonly activeInvocations = new Map<string, { state: GraphInvocationState; parentId?: string }>();
  private readonly activeGraphMechanisms = new Map<string, MechanismChain>();

  constructor(private readonly host: GraphRuntimeHost = {}) {
    this.eventBus = host.eventBus ?? new RuntimeEventBus();
  }

  async execute<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
    graph: Graph<TInputSchema, TOutputSchema>,
    input: SchemaValue<TInputSchema>,
    options: number | GraphExecutionOptions = {},
  ): Promise<GraphRunResult<SchemaValue<TOutputSchema>>> {
    const resolvedOptions = typeof options === "number" ? { maxSteps: options } : options;
    const root: RootRunState = Object.freeze({
      rootRunId: crypto.randomUUID(),
      startedAt: Date.now(),
      budget: new InvocationBudget(resolveInvocationLimits(resolvedOptions.limits)),
      signal: resolvedOptions.signal,
      baseline: resolveHostBaseline(this.host.baseline),
    });
    const maxSteps = resolvedOptions.maxSteps ?? Number.POSITIVE_INFINITY;
    const mechanismRuntime = new MechanismRuntime(this.host.mechanismRuntime, (message) => this.eventBus.emit({
      type: "runtime_warning",
      rootRunId: root.rootRunId,
      code: "unmanaged-mechanism-access",
      message,
    }));
    this.eventBus.emit({
      type: "root_started",
      rootRunId: root.rootRunId,
      graphId: graph.id,
      graphVersion: graph.version,
    });
    this.eventBus.emit({
      type: "host_baseline_selected",
      rootRunId: root.rootRunId,
      baseline: root.baseline.kind,
      id: root.baseline.kind === "custom" ? root.baseline.id : undefined,
      fingerprint: root.baseline.kind === "inherit" ? root.baseline.fingerprint : undefined,
    });
    if (root.baseline.kind !== "isolated") {
      this.eventBus.emit({
        type: "runtime_warning",
        rootRunId: root.rootRunId,
        code: "unsafe-host-baseline",
        message: `Host baseline "${root.baseline.kind}" is not the isolated default`,
      });
    }

    let outcome: InvocationOutcome;
    let hostMechanisms: MechanismChain | undefined;
    try {
      hostMechanisms = await mechanismRuntime.open("host", root.rootRunId, this.host.mechanisms ?? [], {
        rootRunId: root.rootRunId,
      });
      this.eventBus.emit({ type: "mechanism_scope_opened", rootRunId: root.rootRunId, installation: "host", count: hostMechanisms.invocations.length });
      await mechanismRuntime.enter([hostMechanisms], "onRootEnter");
      this.mechanismRuns.set(root, { runtime: mechanismRuntime, host: hostMechanisms });
      const invocation = await this.runInvocation({
        graph,
        input: input as JsonValue,
        boundary: "root",
        root,
        maxSteps,
        mechanismRuntime,
        hostMechanisms,
      });
      outcome = invocation.outcome;
    } catch (error) {
      outcome = failureOutcome(mapUnexpectedFailure(error, root.signal));
    } finally {
      this.mechanismRuns.delete(root);
      if (hostMechanisms) {
        await mechanismRuntime.rootExit(hostMechanisms);
        await mechanismRuntime.close(hostMechanisms);
        this.eventBus.emit({ type: "mechanism_scope_closed", rootRunId: root.rootRunId, installation: "host", count: hostMechanisms.invocations.length });
      }
    }

    const usage = root.budget.usage;
    const steps = usage.nodeVisits;
    const durationMs = Math.max(0, Date.now() - root.startedAt);
    this.eventBus.emit({
      type: "root_finished",
      rootRunId: root.rootRunId,
      status: outcome.status,
      usage,
    });
    const common = {
      rootRunId: root.rootRunId,
      graphId: graph.id,
      graphVersion: graph.version,
      steps,
      durationMs,
      replay: Object.freeze({ mode: "off", status: "off" }),
    } as const;
    if (outcome.status === "completed") {
      return { ...common, status: "completed", output: outcome.output as SchemaValue<TOutputSchema> };
    }
    const failure = outcome.failure ?? runtimeFailure("runtime-error", "root", "Graph failed without a failure object");
    return outcome.status === "cancelled"
      ? { ...common, status: "cancelled", failure: failure as GraphFailure & { code: "cancelled" } }
      : { ...common, status: "failed", failure };
  }

  private async runInvocation(request: InvocationRequest): Promise<{
    readonly outcome: InvocationOutcome;
    readonly frames: readonly JsonValue[];
  }> {
    const { graph, root, parent, boundary } = request;
    const depth = (parent?.depth ?? 0) + 1;
    const frames = request.sharedFrames ?? [];
    const frameRevision = request.sharedFrameRevision ?? { value: 0 };
    let state: GraphInvocationState | undefined;
    let graphMechanisms: MechanismChain | undefined;
    let graphError: unknown;
    try {
      this.assertNotCancelled(root);
      const graphInput = this.validateSchemaBoundary(
        graph.input,
        request.input,
        "invalid-input",
        "graph",
        `Graph input is invalid for ${graph.id}@${graph.version}`,
      );
      root.budget.enterGraph(depth);
      state = Object.freeze({
        graphInvocationId: crypto.randomUUID(),
        rootRunId: root.rootRunId,
        parentGraphInvocationId: parent?.graphInvocationId,
        graph: Object.freeze({ id: graph.id, version: graph.version }),
        boundary,
        depth,
        frames,
        frameRevision,
      });
      this.eventBus.emit({
        type: "graph_entered",
        rootRunId: root.rootRunId,
        graphInvocationId: state.graphInvocationId,
        parentGraphInvocationId: state.parentGraphInvocationId,
        graphId: graph.id,
        graphVersion: graph.version,
        boundary,
        depth,
      });
      this.activeInvocations.set(state.graphInvocationId, { state, parentId: state.parentGraphInvocationId });

      if ((boundary === "call" || boundary === "compose") && this.host.createInvocationAgentHost) {
        const agentHost = await this.host.createInvocationAgentHost({ root, invocation: state });
        this.invocationAgentHosts.set(state.graphInvocationId, agentHost);
      }

      let graphSkills: readonly ResolvedSkillView[];
      try {
        this.validateGraphTools(graph);
        graphSkills = this.resolveSkills(graph.skills);
      } catch (error) {
        const failure = error instanceof RuntimeFailure
          ? error.failure
          : runtimeFailure("invalid-graph", "graph", errorMessage(error), false, undefined, error);
        return this.exitInvocation(state, frames, failureOutcome(failure));
      }

      const contextState = new ContextState({
        rootRunId: root.rootRunId,
        graphInvocationId: state.graphInvocationId,
        graph,
        graphInput,
        graphSkills,
        frames,
        frameRevision,
        externalContributions: (nodeVisitId) => request.mechanismRuntime.contextContributions.filter((item) =>
          item.lifetime === "root-run"
          || item.lifetime === "graph-invocation" && item.scopeId === state!.graphInvocationId
          || item.lifetime === "node-visit" && item.scopeId === nodeVisitId
          || item.lifetime === "agent-run"),
      });
      try {
        await contextState.initialize();
      } catch (error) {
        return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
          "runtime-error",
          "graph",
          `Graph context materialization failed for ${graph.id}@${graph.version}`,
          false,
          undefined,
          error,
        )));
      }
      graphMechanisms = await request.mechanismRuntime.open("graph", state.graphInvocationId, graph.mechanisms ?? [], {
        rootRunId: root.rootRunId,
        graphInvocationId: state.graphInvocationId,
      }, contextState);
      this.activeGraphMechanisms.set(state.graphInvocationId, graphMechanisms);
      this.eventBus.emit({ type: "mechanism_scope_opened", rootRunId: root.rootRunId, graphInvocationId: state.graphInvocationId, installation: "graph", count: graphMechanisms.invocations.length });
      await request.mechanismRuntime.enter([request.hostMechanisms, graphMechanisms], "onGraphEnter");

      const entry = await firstMatchingEntry(graph, graphInput);
      this.assertNotCancelled(root);
      if (!entry) {
        return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
          "entry-not-found",
          "entry",
          `No Entry matched Graph input for ${graph.id}@${graph.version}`,
          false,
        )));
      }

      let stageId = entry.to;
      let nodeInput: JsonValue;
      try {
        nodeInput = entry.mapInput ? entry.mapInput(graphInput as never) : graphInput;
      } catch (error) {
        return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
          "invalid-input",
          "entry",
          `Entry "${entry.id}" failed to map Graph input`,
          false,
          undefined,
          error,
        )));
      }
      const visits = new Map<string, number>();

      for (let localStep = 0; localStep < request.maxSteps; localStep += 1) {
        this.assertNotCancelled(root);
        root.budget.enterNode();
        const stage = graph.stages[stageId];
        if (!stage) {
          return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
            "invalid-graph",
            "graph",
            `Stage not found: ${stageId}`,
            false,
            stageId,
          )));
        }
        const visit = (visits.get(stageId) ?? 0) + 1;
        visits.set(stageId, visit);
        const nodeVisit: NodeVisitState = Object.freeze({
          nodeVisitId: crypto.randomUUID(),
          rootRunId: root.rootRunId,
          graphInvocationId: state.graphInvocationId,
          stageId,
          visit,
        });
        this.eventBus.emit({
          type: "node_entered",
          rootRunId: root.rootRunId,
          graphInvocationId: nodeVisit.graphInvocationId,
          nodeVisitId: nodeVisit.nodeVisitId,
          stageId,
          visit,
        });
        const exitNode = () => this.eventBus.emit({
          type: "node_exited",
          rootRunId: root.rootRunId,
          graphInvocationId: nodeVisit.graphInvocationId,
          nodeVisitId: nodeVisit.nodeVisitId,
          stageId: nodeVisit.stageId,
        });

        try {
          nodeInput = this.validateSchemaBoundary(
            stage.node.input,
            nodeInput,
            "invalid-input",
            "node",
            `Node input is invalid at Stage "${stageId}"`,
            stageId,
          );
        } catch (error) {
          const failure = error instanceof RuntimeFailure
            ? error.failure
            : runtimeFailure("invalid-input", "node", errorMessage(error), false, stageId, error);
          exitNode();
          return this.exitInvocation(state, frames, failureOutcome(failure));
        }

        let completion: NodeCompletion;
        try {
          completion = await this.executeNode(
            graph,
            stage.node,
            nodeInput,
            root,
            state,
            nodeVisit,
            request.maxSteps,
            graphSkills,
            contextState,
            request.mechanismRuntime,
            request.hostMechanisms,
            graphMechanisms,
          );
          this.assertNotCancelled(root);
        } catch (error) {
          const failure = error instanceof RuntimeFailure
            ? error.failure
            : error instanceof MechanismRuntimeError
              ? runtimeFailure("mechanism-failed", error.failure.installation === "node" ? "node" : "graph", error.message, false, stageId, error)
            : isCancellationError(error, root.signal)
              ? cancelledFailure(error)
            : runtimeFailure("runtime-error", stage.node.kind === "agent" ? "agent" : "node", errorMessage(error), true, stageId, error);
          exitNode();
          return this.exitInvocation(state, frames, failureOutcome(failure));
        }

        try {
          const result = this.validateSchemaBoundary(
            stage.node.output,
            completion.result,
            "validation-exhausted",
            stage.node.kind === "agent" ? "agent" : "node",
            `Node output is invalid at Stage "${stageId}"`,
            stageId,
          );
          completion = Object.freeze({ result });
        } catch (error) {
          const failure = error instanceof RuntimeFailure
            ? error.failure
            : runtimeFailure("validation-exhausted", "node", errorMessage(error), false, stageId, error);
          exitNode();
          return this.exitInvocation(state, frames, failureOutcome(failure));
        }

        let connection: Connection | undefined;
        try {
          connection = await selectConnection(stage.route, completion);
          this.assertNotCancelled(root);
        } catch (error) {
          if (error instanceof RuntimeFailure) {
            exitNode();
            return this.exitInvocation(state, frames, failureOutcome(error.failure));
          }
          if (isCancellationError(error, root.signal)) {
            exitNode();
            return this.exitInvocation(state, frames, failureOutcome(cancelledFailure(error)));
          }
          exitNode();
          return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
            "transition-failed",
            "route",
            `Route evaluation failed at Stage "${stageId}"`,
            true,
            stageId,
            error,
          )));
        }
        if (!connection) {
          exitNode();
          return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
            "no-route",
            "route",
            `No Connection matched at Stage "${stageId}"`,
            false,
            stageId,
          )));
        }
        this.eventBus.emit({
          type: "transition_selected",
          rootRunId: root.rootRunId,
          graphInvocationId: state.graphInvocationId,
          nodeVisitId: nodeVisit.nodeVisitId,
          stageId,
          connectionId: connection.id,
          target: connection.to,
        });

        const transitionInput = { completion } as const;
        try {
          if (connection.transition.frame) {
            frames.push(connection.transition.frame(transitionInput));
            contextState.bumpMemoryRevision();
          }
          this.assertNotCancelled(root);
          if (connection.to === "__graph_finish__") {
            const output = connection.transition.output?.(transitionInput);
            if (output === undefined) {
              throw new Error(`Finish Connection "${connection.id}" did not produce output`);
            }
            this.assertNotCancelled(root);
            const validatedOutput = this.validateSchemaBoundary(
              graph.output,
              output,
              "validation-exhausted",
              "graph",
              `Graph output is invalid for ${graph.id}@${graph.version}`,
              stageId,
            );
            exitNode();
            return this.exitInvocation(state, frames, completedOutcome(validatedOutput));
          }
          nodeInput = connection.transition.map?.(transitionInput) ?? completion.result;
          this.assertNotCancelled(root);
          stageId = connection.to;
          exitNode();

          // Node-boundary checkpoint: transition done, next Node not yet started.
          await this.writeNodeCheckpoint(
            root,
            state,
            nodeVisit,
            stageId,
            nodeInput,
            frames,
            request.mechanismRuntime,
            request.hostMechanisms,
          );
        } catch (error) {
          if (error instanceof RuntimeFailure) {
            exitNode();
            return this.exitInvocation(state, frames, failureOutcome(error.failure));
          }
          if (isCancellationError(error, root.signal)) {
            exitNode();
            return this.exitInvocation(state, frames, failureOutcome(cancelledFailure(error)));
          }
          exitNode();
          return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
            "transition-failed",
            "transition",
            `Transition "${connection.id}" failed`,
            true,
            stageId,
            error,
          )));
        }
      }
      return this.exitInvocation(state, frames, failureOutcome(runtimeFailure(
        "max-steps-exceeded",
        "graph",
        `Graph Invocation exceeded maxSteps ${request.maxSteps}`,
        false,
        stageId,
      )));
    } catch (error) {
      graphError = error;
      const failure = mapUnexpectedFailure(error, root.signal);
      if (!state) return { outcome: failureOutcome(failure), frames: Object.freeze([...frames]) };
      return this.exitInvocation(state, frames, failureOutcome(failure));
    } finally {
      if (state) {
        const agentHost = this.invocationAgentHosts.get(state.graphInvocationId);
        this.invocationAgentHosts.delete(state.graphInvocationId);
        this.activeInvocations.delete(state.graphInvocationId);
        await agentHost?.dispose();
      }
      if (graphMechanisms) {
        this.activeGraphMechanisms.delete(state!.graphInvocationId);
        await request.mechanismRuntime.graphExit([request.hostMechanisms, graphMechanisms], graphError);
        await request.mechanismRuntime.close(graphMechanisms);
        this.eventBus.emit({ type: "mechanism_scope_closed", rootRunId: root.rootRunId, graphInvocationId: state?.graphInvocationId, installation: "graph", count: graphMechanisms.invocations.length });
      }
    }
  }

  private exitInvocation(
    state: GraphInvocationState,
    frames: readonly JsonValue[],
    outcome: InvocationOutcome,
  ): { readonly outcome: InvocationOutcome; readonly frames: readonly JsonValue[] } {
    this.eventBus.emit({
      type: "graph_exited",
      rootRunId: state.rootRunId,
      graphInvocationId: state.graphInvocationId,
      status: outcome.status,
      failure: outcome.failure,
    });
    return { outcome, frames: Object.freeze([...frames]) };
  }

  private async executeNode(
    graph: Graph,
    node: NodeDefinition,
    input: JsonValue,
    root: RootRunState,
    invocation: GraphInvocationState,
    nodeVisit: NodeVisitState,
    maxSteps: number,
    graphSkills: readonly ResolvedSkillView[],
    contextState: ContextState,
    mechanismRuntime: MechanismRuntime,
    hostMechanisms: MechanismChain,
    graphMechanisms: MechanismChain,
  ): Promise<NodeCompletion> {
    const capabilities = this.resolveNodeCapabilities(
      graph,
      nodeVisit.stageId,
      node,
      graphSkills,
      root,
      invocation,
    );
    const nodeMechanisms = await mechanismRuntime.open("node", nodeVisit.nodeVisitId, node.mechanisms ?? [], {
      rootRunId: root.rootRunId,
      graphInvocationId: invocation.graphInvocationId,
      nodeVisitId: nodeVisit.nodeVisitId,
      stageId: nodeVisit.stageId,
    }, contextState);
    this.eventBus.emit({ type: "mechanism_scope_opened", rootRunId: root.rootRunId, graphInvocationId: invocation.graphInvocationId, nodeVisitId: nodeVisit.nodeVisitId, installation: "node", count: nodeMechanisms.invocations.length });
    const chains = [hostMechanisms, graphMechanisms, nodeMechanisms] as const;
    try {
      await mechanismRuntime.enter(chains, "onNodeEnter");
      const { snapshot } = await contextState.materializeNode(
        nodeVisit.nodeVisitId,
        nodeVisit.stageId,
        graph.stages[nodeVisit.stageId],
        input,
        capabilities.skills,
      );
      this.eventBus.emit({
        type: "context_snapshot_materialized",
        rootRunId: root.rootRunId,
        graphInvocationId: invocation.graphInvocationId,
        nodeVisitId: nodeVisit.nodeVisitId,
        memoryRevision: snapshot.memoryRevision,
        layerCount: snapshot.layers.length,
      });
      let result: JsonValue;
      if (node.kind === "agent") {
        result = await this.runAgent(
        graph,
        node,
        input,
        root,
        invocation,
        nodeVisit,
        1,
        maxSteps,
        capabilities.tools,
        capabilities.skills,
        snapshot,
        contextState,
        mechanismRuntime,
        chains,
      );
      } else if (node.kind === "graph") {
        result = await this.executeGraphNode(node, input, root, invocation, maxSteps);
      } else {
        let agentIndex = 0;
        result = await node.execute({
          input: input as never,
          complete: (value) => value,
          rootRunId: root.rootRunId,
          nodeVisitId: nodeVisit.nodeVisitId,
          runAgent: async (agentRequest) => ({
            result: await this.runCodeAgent(
          agentRequest,
          node,
          root,
          invocation,
          nodeVisit,
          ++agentIndex,
          maxSteps,
          capabilities.tools,
          capabilities.skills,
          snapshot,
          contextState,
          mechanismRuntime,
          chains,
            ),
          }),
        }) as JsonValue;
      }
      await mechanismRuntime.nodeExit(chains, result);
      return { result };
    } catch (error) {
      await mechanismRuntime.nodeError(chains, error);
      throw error;
    } finally {
      await mechanismRuntime.close(nodeMechanisms);
      this.eventBus.emit({ type: "mechanism_scope_closed", rootRunId: root.rootRunId, graphInvocationId: invocation.graphInvocationId, nodeVisitId: nodeVisit.nodeVisitId, installation: "node", count: nodeMechanisms.invocations.length });
    }
  }

  private async runAgent(
    graph: Graph,
    node: AgentNodeDefinition,
    input: JsonValue,
    root: RootRunState,
    invocation: GraphInvocationState,
    nodeVisit: NodeVisitState,
    index: number,
    maxSteps: number,
    tools: readonly ToolImplementation[],
    skills: readonly ResolvedSkillView[],
    snapshot: ContextSnapshot,
    contextState: ContextState,
    mechanismRuntime: MechanismRuntime,
    mechanismChains: readonly MechanismChain[],
  ): Promise<JsonValue> {
    const runAgent = this.invocationAgentHosts.get(invocation.graphInvocationId)?.runAgent ?? this.host.runAgent;
    if (!runAgent) throw new RuntimeFailure(runtimeFailure("host-unavailable", "host", "Agent Node requires host.runAgent", false, nodeVisit.stageId));
    const state = this.beginAgent(root, invocation, nodeVisit, index);
    try {
      await mechanismRuntime.beforeAgentRun(mechanismChains, state.agentRunId, node.prompt ?? node.subGoal);
      return await runAgent(node, input, this.createAgentContext(
        root,
        invocation,
        nodeVisit,
        state,
        maxSteps,
        tools,
        skills,
        contextState.refreshSnapshot(snapshot, state.agentRunId),
        node.output,
        graph.stages[nodeVisit.stageId]?.route,
        mechanismRuntime,
        mechanismChains,
        mechanismChains.at(-1),
      ));
    } finally {
      await mechanismRuntime.afterAgentRun(mechanismChains, state.agentRunId);
      this.finishAgent(state);
    }
  }

  private async runCodeAgent(
    request: AgentRunRequest,
    node: CodeNodeDefinition,
    root: RootRunState,
    invocation: GraphInvocationState,
    nodeVisit: NodeVisitState,
    index: number,
    maxSteps: number,
    tools: readonly ToolImplementation[],
    skills: readonly ResolvedSkillView[],
    snapshot: ContextSnapshot,
    contextState: ContextState,
    mechanismRuntime: MechanismRuntime,
    mechanismChains: readonly MechanismChain[],
  ): Promise<JsonValue> {
    const runAgentFromCode = this.invocationAgentHosts.get(invocation.graphInvocationId)?.runAgentFromCode ?? this.host.runAgentFromCode;
    if (!runAgentFromCode) throw new RuntimeFailure(runtimeFailure("host-unavailable", "host", "Code Node runAgent requires host.runAgentFromCode", false, nodeVisit.stageId));
    const state = this.beginAgent(root, invocation, nodeVisit, index);
    try {
      await mechanismRuntime.beforeAgentRun(mechanismChains, state.agentRunId, request.prompt);
      return await runAgentFromCode(request, node, this.createAgentContext(
        root,
        invocation,
        nodeVisit,
        state,
        maxSteps,
        tools,
        skills,
        contextState.refreshSnapshot(snapshot, state.agentRunId),
        request.output as TSchema,
        undefined,
        mechanismRuntime,
        mechanismChains,
        mechanismChains.at(-1),
      ));
    } finally {
      await mechanismRuntime.afterAgentRun(mechanismChains, state.agentRunId);
      this.finishAgent(state);
    }
  }

  private beginAgent(
    root: RootRunState,
    invocation: GraphInvocationState,
    nodeVisit: NodeVisitState,
    index: number,
  ): AgentRunState {
    const state = Object.freeze({
      agentRunId: crypto.randomUUID(),
      rootRunId: root.rootRunId,
      graphInvocationId: invocation.graphInvocationId,
      nodeVisitId: nodeVisit.nodeVisitId,
      index,
    });
    this.eventBus.emit({ type: "agent_started", ...state });
    return state;
  }

  private finishAgent(state: AgentRunState): void {
    this.eventBus.emit({ type: "agent_finished", ...state });
  }

  private createAgentContext(
    root: RootRunState,
    invocation: GraphInvocationState,
    nodeVisit: NodeVisitState,
    agentRun: AgentRunState,
    maxSteps: number,
    tools: readonly ToolImplementation[],
    skills: readonly ResolvedSkillView[],
    snapshot: ContextSnapshot,
    outputSchema: TSchema,
    route: import("../core/graph.js").Route | undefined,
    mechanismRuntime: MechanismRuntime,
    mechanismChains: readonly MechanismChain[],
    mechanisms?: MechanismChain,
  ): AgentExecutionContext {
    const agentSnapshot = Object.freeze({ ...snapshot, agentRunId: agentRun.agentRunId });
    this.assertStickyContextBudget(agentSnapshot, nodeVisit.stageId);
    return Object.freeze({
      root,
      invocation,
      nodeVisit,
      agentRun,
      tools,
      skills,
      baseline: root.baseline,
      snapshot: agentSnapshot,
      mechanisms,
      validateNodeCompletion: async (result: JsonValue) => {
        try {
          const checked = checkJsonSchemaValue(outputSchema, result);
          return checked.valid
            ? { valid: true }
            : { valid: false, reason: `Node output is invalid at Stage "${nodeVisit.stageId}": ${checked.message ?? "schema validation failed"}` };
        } catch (error) {
          return { valid: false, reason: `Invalid Node output schema: ${errorMessage(error)}` };
        }
      },
      validateRouteStructure: async (result: JsonValue) => validateRouteStructure(route, result),
      validateMechanismCompletion: (result: JsonValue) =>
        mechanismRuntime.validateCompletion(mechanismChains, agentRun.agentRunId, result),
      validateAgentChoice: async (result: JsonValue) => validateAgentChoice(route, result),
      invokeGraph: (ref: GraphRef, input: JsonValue, boundary: Exclude<InvocationBoundary, "root"> = "call") =>
        this.invokeGraph(ref, input, boundary, root, invocation, maxSteps),
    });
  }

  private assertStickyContextBudget(snapshot: ContextSnapshot, stageId: string): void {
    const limit = this.host.maxStickyContextBytes ?? 256 * 1024;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RuntimeFailure(runtimeFailure("runtime-error", "host", "maxStickyContextBytes must be a positive integer", false, stageId));
    }
    const bytes = Buffer.byteLength(JSON.stringify(snapshot.layers
      .filter((layer) => layer.retention === "sticky")
      .map((layer) => layer.content)), "utf8");
    if (bytes > limit) {
      throw new RuntimeFailure(runtimeFailure(
        "runtime-error",
        "agent",
        `Sticky context budget exceeded: ${bytes} bytes > ${limit} bytes`,
        false,
        stageId,
      ));
    }
  }

  private async executeGraphNode(
    node: GraphNodeDefinition,
    input: JsonValue,
    root: RootRunState,
    parent: GraphInvocationState,
    maxSteps: number,
  ): Promise<JsonValue> {
    const result = await this.invokeGraph(node.graph, input, node.boundary, root, parent, maxSteps);
    if (result.status !== "completed" || result.output === undefined) {
      throw new RuntimeFailure(result.failure ?? (
        result.status === "cancelled"
          ? cancelledFailure()
          : runtimeFailure("runtime-error", "graph", `Child Graph failed: ${node.graph.id}`, true)
      ));
    }
    return result.output;
  }

  private async invokeGraph(
    ref: GraphRef,
    input: JsonValue,
    boundary: Exclude<InvocationBoundary, "root">,
    root: RootRunState,
    parent: GraphInvocationState,
    maxSteps: number,
  ): Promise<InvocationOutcome> {
    const graph = this.resolveGraph(ref);
    if (!graph) {
      return failureOutcome(runtimeFailure(
        "invalid-graph",
        "graph",
        `GraphRef not found: ${ref.id}@${ref.version}`,
        false,
      ));
    }
    const execute = async () => (await this.runInvocation({
      graph,
      input,
      boundary,
      root,
      parent,
      sharedFrames: boundary === "compose" ? parent.frames : undefined,
      sharedFrameRevision: boundary === "compose" ? parent.frameRevision : undefined,
      maxSteps,
      mechanismRuntime: this.mechanismRuns.get(root)?.runtime ?? new MechanismRuntime(this.host.mechanismRuntime),
      hostMechanisms: this.mechanismRuns.get(root)?.host ?? { invocations: [] },
    })).outcome;
    if (boundary !== "delegate") return await execute();
    if (!this.host.delegateGraph) {
      return failureOutcome(runtimeFailure(
        "host-unavailable",
        "host",
        `Delegate Host unavailable for GraphRef: ${ref.id}@${ref.version}`,
        false,
      ));
    }
    return await this.host.delegateGraph({ graph, input, root, parentInvocation: parent, execute });
  }

  private validateGraphTools(graph: Graph): void {
    try {
      preflightGraphCapabilities(graph, this.host);
    } catch (error) {
      if (error instanceof CapabilityPreflightError) {
        throw new RuntimeFailure(runtimeFailure(
          error.code,
          error.phase,
          error.message,
          false,
          error.stageId,
          error,
        ));
      }
      throw error;
    }
  }

  private resolveNodeCapabilities(
    graph: Graph,
    stageId: string,
    node: NodeDefinition,
    graphSkills: readonly ResolvedSkillView[],
    root: RootRunState,
    invocation: GraphInvocationState,
  ): {
    readonly tools: readonly ToolImplementation[];
    readonly skills: readonly ResolvedSkillView[];
  } {
    const policy = graph.tools ?? [];
    let names: readonly string[];
    try {
      names = resolveNodeToolNames(graph, stageId, node, this.host);
    } catch (error) {
      if (error instanceof CapabilityPreflightError) {
        throw new RuntimeFailure(runtimeFailure(error.code, error.phase, error.message, false, error.stageId, error));
      }
      throw error;
    }
    if (this.host.unsafeToolResolver) {
      const outsidePolicy = [...new Set(names)].filter((name) =>
        name !== RUNTIME_PROTOCOL_TOOL_NAME && !policy.includes(name)
      );
      if (outsidePolicy.length > 0) {
        this.eventBus.emit({
          type: "runtime_warning",
          rootRunId: root.rootRunId,
          graphInvocationId: invocation.graphInvocationId,
          stageId,
          code: "unsafe-tool-policy-bypass",
          message: `Unsafe resolver enabled tools outside Graph policy: ${outsidePolicy.join(", ")}`,
        });
      }
    }

    const tools: ToolImplementation[] = [];
    for (const name of [...new Set(names)]) {
      if (name === RUNTIME_PROTOCOL_TOOL_NAME) continue;
      const tool = this.host.toolCatalog?.resolve(name);
      if (!tool) {
        throw new RuntimeFailure(runtimeFailure(
          "tool-unavailable",
          "host",
          `Host tool unavailable: ${name}`,
          false,
          stageId,
        ));
      }
      tools.push(tool);
    }
    const protocolTools = this.host.protocolTools ?? [Object.freeze({
      name: RUNTIME_PROTOCOL_TOOL_NAME,
      protocol: true,
    })];
    const completionTool = protocolTools.find((tool) => tool.name === RUNTIME_PROTOCOL_TOOL_NAME);
    if (!completionTool) {
      throw new RuntimeFailure(runtimeFailure(
        "host-unavailable",
        "host",
        `Runtime protocol tool unavailable: ${RUNTIME_PROTOCOL_TOOL_NAME}`,
        false,
        stageId,
      ));
    }
    tools.push(completionTool);
    return Object.freeze({
      tools: Object.freeze(tools),
      skills: Object.freeze([
        ...graphSkills,
        ...this.resolveSkills(node.skills),
      ]),
    });
  }

  private resolveSkills(refs: readonly SkillRef[] | undefined): readonly ResolvedSkillView[] {
    if (!refs?.length) return Object.freeze([]);
    const resolved: ResolvedSkillView[] = [];
    for (const ref of refs) {
      let skill: ResolvedSkillView | undefined;
      try {
        skill = this.host.skillCatalog?.resolve(ref);
      } catch (error) {
        if (!ref.required) continue;
        throw new RuntimeFailure(runtimeFailure(
          "host-unavailable",
          "host",
          `Required Skill resolution failed: ${ref.name}${ref.version ? `@${ref.version}` : ""}: ${errorMessage(error)}`,
          false,
          undefined,
          error,
        ));
      }
      if (skill) {
        resolved.push(skill);
        continue;
      }
      if (ref.required) {
        throw new RuntimeFailure(runtimeFailure(
          "host-unavailable",
          "host",
          `Required Skill unavailable: ${ref.name}${ref.version ? `@${ref.version}` : ""}`,
          false,
        ));
      }
    }
    return Object.freeze(resolved);
  }

  private resolveGraph(ref: GraphRef): Graph | undefined {
    return this.host.catalog?.resolve(ref) ?? this.host.resolveGraph?.(ref);
  }

  private buildInvocationStack(rootRunId: string): readonly {
    readonly graphInvocationId: string;
    readonly parentGraphInvocationId?: string;
    readonly boundary: "root" | "call" | "compose" | "delegate";
    readonly depth: number;
    readonly graph: GraphRef;
  }[] {
    // Walk all active invocations from root to deepest, ordered by depth.
    const byParent = new Map<string | undefined, string[]>();
    for (const [id, entry] of this.activeInvocations) {
      if (entry.state.rootRunId !== rootRunId) continue;
      const key = entry.parentId ?? undefined;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(id);
    }
    const stack: ReturnType<typeof this.buildInvocationStack>[number][] = [];
    let current: string | undefined = byParent.get(undefined)?.[0];
    while (current) {
      const entry = this.activeInvocations.get(current);
      if (!entry) break;
      stack.push({
        graphInvocationId: entry.state.graphInvocationId,
        parentGraphInvocationId: entry.state.parentGraphInvocationId,
        boundary: entry.state.boundary,
        depth: entry.state.depth,
        graph: entry.state.graph,
      });
      current = byParent.get(current)?.[0];
    }
    return Object.freeze(stack);
  }

  private async writeNodeCheckpoint(
    root: RootRunState,
    invocation: GraphInvocationState,
    _nodeVisit: NodeVisitState,
    nextStageId: string,
    nextNodeInput: JsonValue,
    frames: readonly JsonValue[],
    mechanismRuntime: MechanismRuntime,
    hostMechanisms: MechanismChain,
  ): Promise<void> {
    const store = this.host.checkpointStore;
    if (!store) return;
    try {
      const invocationStack = this.buildInvocationStack(root.rootRunId);
      // A nested continuation needs parent return/transition state in addition to
      // the active stack. Until that is encoded, never persist a misleading point.
      if (invocationStack.length !== 1 || invocation.boundary !== "root") return;
      const graphChains = [...this.activeGraphMechanisms.values()];
      const mechanisms = mechanismRuntime.snapshotAll([hostMechanisms, ...graphChains]);
      const checkpoint: CheckpointNodeBoundary = Object.freeze({
        kind: "node-boundary",
        schemaVersion: 1 as const,
        checkpointId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        rootRunId: root.rootRunId,
        graph: invocation.graph,
        invocationStack,
        next: Object.freeze({ stageId: nextStageId, nodeInput: nextNodeInput, nodeVisitId: crypto.randomUUID() }),
        frames: Object.freeze([...frames]),
        budget: { ...root.budget.usage } as JsonValue,
        resumeAttempt: 0,
        mechanisms,
      });
      await store.writeCheckpoint(root.rootRunId, checkpoint.checkpointId, encodeCheckpoint(checkpoint));
      this.eventBus.emit({
        type: "checkpoint_saved",
        rootRunId: root.rootRunId,
        graphInvocationId: invocation.graphInvocationId,
        checkpointId: checkpoint.checkpointId,
        nextStageId,
      });
    } catch (error) {
      // Checkpoint write failure must not alter business control flow.
      this.eventBus.emit({
        type: "runtime_warning",
        rootRunId: root.rootRunId,
        graphInvocationId: invocation.graphInvocationId,
        code: "unmanaged-mechanism-access",
        message: `Checkpoint write failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** Resume a root graph run from the latest checkpoint. */
  async resume<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
    graph: Graph<TInputSchema, TOutputSchema>,
    options: {
      readonly runId: string;
      readonly signal?: AbortSignal;
      readonly checkpointMigrator?: (saved: { readonly id: string; readonly version: string }) => { readonly id: string; readonly version: string };
      readonly maxSteps?: number;
    },
  ): Promise<GraphRunResult<SchemaValue<TOutputSchema>>> {
    const store = this.host.checkpointStore;
    if (!store) {
      return {
        rootRunId: options.runId,
        graphId: graph.id,
        graphVersion: graph.version,
        steps: 0,
        durationMs: 0,
        replay: Object.freeze({ mode: "off", status: "off" }),
        status: "failed",
        failure: runtimeFailure("resume-incompatible", "host", "No checkpoint store configured; cannot resume", false),
      };
    }

    let checkpointIds: readonly string[];
    try {
      checkpointIds = await (store.listCheckpoints?.(options.runId) ?? []);
    } catch {
      return {
        rootRunId: options.runId,
        graphId: graph.id,
        graphVersion: graph.version,
        steps: 0,
        durationMs: 0,
        replay: Object.freeze({ mode: "off", status: "off" }),
        status: "failed",
        failure: runtimeFailure("resume-incompatible", "host", "Failed to list checkpoints", false),
      };
    }
    if (checkpointIds.length === 0) {
      return {
        rootRunId: options.runId,
        graphId: graph.id,
        graphVersion: graph.version,
        steps: 0,
        durationMs: 0,
        replay: Object.freeze({ mode: "off", status: "off" }),
        status: "failed",
        failure: runtimeFailure("resume-incompatible", "host", `No checkpoints found for runId: ${options.runId}`, false),
      };
    }

    // Checkpoint ids are opaque UUIDs. Inspect ordering metadata instead of
    // assuming lexicographic filename order represents write order.
    let latestId = "";
    let checkpoint: CheckpointNodeBoundary | undefined;
    try {
      for (const id of checkpointIds) {
        const candidate = decodeCheckpoint(await store.readCheckpoint(options.runId, id));
        if (!checkpoint || checkpointOrder(candidate) > checkpointOrder(checkpoint)) {
          checkpoint = candidate;
          latestId = id;
        }
      }
    } catch (error) {
      return {
        rootRunId: options.runId,
        graphId: graph.id,
        graphVersion: graph.version,
        steps: 0,
        durationMs: 0,
        replay: Object.freeze({ mode: "off", status: "off" }),
        status: "failed",
        failure: runtimeFailure("resume-incompatible", "host", `Failed to read or decode checkpoint ${latestId || "unknown"}`, false, undefined, error),
      };
    }
    if (!checkpoint) throw new Error("Checkpoint selection failed");

    // Version check
    let resolvedGraphId = graph.id;
    let resolvedGraphVersion = graph.version;
    if (checkpoint.graph.id !== graph.id || checkpoint.graph.version !== graph.version) {
      if (!options.checkpointMigrator) {
        return {
          rootRunId: options.runId,
          graphId: graph.id,
          graphVersion: graph.version,
          steps: 0,
          durationMs: 0,
          replay: Object.freeze({ mode: "off", status: "off" }),
          status: "failed",
          failure: runtimeFailure(
            "resume-incompatible", "host",
            `Checkpoint graph ${checkpoint.graph.id}@${checkpoint.graph.version} does not match ${graph.id}@${graph.version} and no migrator provided`,
            false,
          ),
        };
      }
      const migrated = options.checkpointMigrator(checkpoint.graph);
      if (migrated.id !== graph.id || migrated.version !== graph.version) {
        return {
          rootRunId: options.runId, graphId: graph.id, graphVersion: graph.version, steps: 0, durationMs: 0,
          replay: Object.freeze({ mode: "off", status: "off" }), status: "failed",
          failure: runtimeFailure("resume-incompatible", "host", `Checkpoint migrator resolved ${migrated.id}@${migrated.version}, expected ${graph.id}@${graph.version}`, false),
        };
      }
      resolvedGraphId = migrated.id;
      resolvedGraphVersion = migrated.version;
    }

    if (checkpoint.rootRunId !== options.runId) {
      return {
        rootRunId: options.runId,
        graphId: graph.id,
        graphVersion: graph.version,
        steps: 0,
        durationMs: 0,
        replay: Object.freeze({ mode: "off", status: "off" }),
        status: "failed",
        failure: runtimeFailure("resume-incompatible", "host", `Checkpoint runId mismatch: ${checkpoint.rootRunId} vs ${options.runId}`, false),
      };
    }

    const resumeAttempt = checkpoint.resumeAttempt + 1;
    const root: RootRunState = Object.freeze({
      rootRunId: options.runId,
      startedAt: Date.now(),
      budget: new InvocationBudget(resolveInvocationLimits()),
      signal: options.signal,
      baseline: resolveHostBaseline(this.host.baseline),
    });
    root.budget.restore(checkpoint.budget as never);

    const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
    const mechanismRuntime = new MechanismRuntime(this.host.mechanismRuntime, (message) => this.eventBus.emit({
      type: "runtime_warning",
      rootRunId: root.rootRunId,
      code: "unmanaged-mechanism-access",
      message,
    }));

    this.eventBus.emit({
      type: "root_started",
      rootRunId: root.rootRunId,
      graphId: resolvedGraphId,
      graphVersion: resolvedGraphVersion,
    });

    let outcome: InvocationOutcome | undefined;
    let hostMechanisms: MechanismChain | undefined;
    const openGraphChains: MechanismChain[] = [];
    try {
      hostMechanisms = await mechanismRuntime.open("host", root.rootRunId, this.host.mechanisms ?? [], {
        rootRunId: root.rootRunId,
      });
      await mechanismRuntime.enter([hostMechanisms], "onRootEnter");
      this.mechanismRuns.set(root, { runtime: mechanismRuntime, host: hostMechanisms });

      if (checkpoint.invocationStack.length !== 1 || checkpoint.invocationStack[0]?.boundary !== "root") {
        outcome = failureOutcome(runtimeFailure("resume-incompatible", "host", "Nested invocation checkpoints are not supported by this checkpoint schema", false));
      }
      const refGraph = graph;

      // Restore mechanism state from checkpoint: open graph mechanisms per invocation
      for (const entry of outcome ? [] : checkpoint.invocationStack) {
        if (!refGraph) {
          outcome = failureOutcome(runtimeFailure("invalid-graph", "graph", `Graph not found: ${resolvedGraphId}@${resolvedGraphVersion}`, false));
          break;
        }
        const gm = await mechanismRuntime.open("graph", entry.graphInvocationId, refGraph.mechanisms ?? [], {
          rootRunId: root.rootRunId,
          graphInvocationId: entry.graphInvocationId,
        });
        openGraphChains.push(gm);
      }
      if (!outcome) {
        try {
          mechanismRuntime.restoreState([hostMechanisms, ...openGraphChains], checkpoint.mechanisms);
        } catch (error) {
          outcome = failureOutcome(runtimeFailure("resume-incompatible", "host", `Mechanism checkpoint restore failed: ${errorMessage(error)}`, false, undefined, error));
        }

        const deepest = outcome ? undefined : checkpoint.invocationStack[checkpoint.invocationStack.length - 1];
        if (!deepest) {
          outcome = failureOutcome(runtimeFailure("resume-incompatible", "host", "Checkpoint has empty invocation stack", false));
        } else {
          const graphMechanisms = openGraphChains[openGraphChains.length - 1];
          outcome = await this.resumeFromCheckpoint(
            graph,
            checkpoint,
            root,
            maxSteps,
            mechanismRuntime,
            hostMechanisms,
            graphMechanisms ?? { invocations: [] },
            resumeAttempt,
          );
        }
      }
    } catch (error) {
      outcome = failureOutcome(mapUnexpectedFailure(error, root.signal));
    } finally {
      this.mechanismRuns.delete(root);
      // Close graph mechanisms opened during resume
      for (const chain of [...openGraphChains].reverse()) {
        try { await mechanismRuntime.close(chain); } catch { /* cleanup is best-effort */ }
      }
      if (hostMechanisms) {
        await mechanismRuntime.rootExit(hostMechanisms);
        await mechanismRuntime.close(hostMechanisms);
      }
    }

    const usage = root.budget.usage;
    const steps = usage.nodeVisits;
    const durationMs = Math.max(0, Date.now() - root.startedAt);
    this.eventBus.emit({
      type: "root_finished",
      rootRunId: root.rootRunId,
      status: outcome.status,
      usage,
    });
    const common = {
      rootRunId: root.rootRunId,
      graphId: graph.id,
      graphVersion: graph.version,
      steps,
      durationMs,
      replay: Object.freeze({ mode: "off", status: "off" }),
    } as const;
    if (outcome.status === "completed") {
      return { ...common, status: "completed", output: outcome.output as SchemaValue<TOutputSchema> };
    }
    const failure = outcome.failure ?? runtimeFailure("runtime-error", "root", "Graph failed without a failure object");
    return outcome.status === "cancelled"
      ? { ...common, status: "cancelled", failure: failure as GraphFailure & { code: "cancelled" } }
      : { ...common, status: "failed", failure };
  }

  private async resumeFromCheckpoint(
    graph: Graph,
    checkpoint: CheckpointNodeBoundary,
    root: RootRunState,
    maxSteps: number,
    mechanismRuntime: MechanismRuntime,
    hostMechanisms: MechanismChain,
    graphMechanisms: MechanismChain,
    resumeAttempt: number,
  ): Promise<InvocationOutcome> {
    const deepest = checkpoint.invocationStack[checkpoint.invocationStack.length - 1];
    if (!deepest) {
      return failureOutcome(runtimeFailure("resume-incompatible", "host", "Checkpoint has empty invocation stack", false));
    }
    const boundary = deepest.boundary;
    const frames = [...checkpoint.frames];
    const invocation: GraphInvocationState = {
      graphInvocationId: deepest.graphInvocationId,
      rootRunId: root.rootRunId,
      parentGraphInvocationId: deepest.parentGraphInvocationId,
      graph: { id: checkpoint.graph.id, version: checkpoint.graph.version },
      boundary,
      depth: deepest.depth,
      frames,
      frameRevision: { value: 0 },
    };
    this.activeInvocations.set(invocation.graphInvocationId, { state: invocation, parentId: invocation.parentGraphInvocationId });
    try {
      this.eventBus.emit({
        type: "graph_entered",
        rootRunId: root.rootRunId,
        graphInvocationId: invocation.graphInvocationId,
        parentGraphInvocationId: invocation.parentGraphInvocationId,
        graphId: checkpoint.graph.id,
        graphVersion: checkpoint.graph.version,
        boundary,
        depth: deepest.depth,
      });

      const graphSkills = this.resolveSkills(graph.skills);
      const graphInput = checkpoint.next.nodeInput;

      const contextState = new ContextState({
        rootRunId: root.rootRunId,
        graphInvocationId: invocation.graphInvocationId,
        graph,
        graphInput,
        graphSkills,
        frames: [...checkpoint.frames],
        frameRevision: { value: 0 },
        externalContributions: (nodeVisitId) => mechanismRuntime.contextContributions.filter((item) =>
          item.lifetime === "root-run"
          || item.lifetime === "graph-invocation" && item.scopeId === invocation.graphInvocationId
          || item.lifetime === "node-visit" && item.scopeId === nodeVisitId
          || item.lifetime === "agent-run"),
      });
      await contextState.initialize();

      try {
        this.activeGraphMechanisms.set(invocation.graphInvocationId, graphMechanisms);
        await mechanismRuntime.enter([hostMechanisms, graphMechanisms], "onGraphEnter");

        let stageId = checkpoint.next.stageId;
        let nodeInput: JsonValue = checkpoint.next.nodeInput;
        const visits = new Map<string, number>();

        for (let localStep = 0; localStep < maxSteps; localStep += 1) {
          this.assertNotCancelled(root);
          root.budget.enterNode();
          const stage = graph.stages[stageId];
          if (!stage) {
            return failureOutcome(runtimeFailure("invalid-graph", "graph", `Stage not found: ${stageId}`, false, stageId));
          }
          const visit = (visits.get(stageId) ?? 0) + 1;
          visits.set(stageId, visit);

          // Inject resume identity for Code Node idempotency
          const nodeVisit: NodeVisitState = Object.freeze({
            nodeVisitId: checkpoint.next.nodeVisitId ?? stableResumeNodeVisitId(checkpoint),
            rootRunId: root.rootRunId,
            graphInvocationId: invocation.graphInvocationId,
            stageId,
            visit,
          });
          this.eventBus.emit({
            type: "node_entered",
            rootRunId: root.rootRunId,
            graphInvocationId: nodeVisit.graphInvocationId,
            nodeVisitId: nodeVisit.nodeVisitId,
            stageId,
            visit,
          });
          const exitNode = () => this.eventBus.emit({
            type: "node_exited",
            rootRunId: root.rootRunId,
            graphInvocationId: nodeVisit.graphInvocationId,
            nodeVisitId: nodeVisit.nodeVisitId,
            stageId: nodeVisit.stageId,
          });

          try {
            nodeInput = this.validateSchemaBoundary(
              stage.node.input,
              nodeInput,
              "invalid-input",
              "node",
              `Node input is invalid at Stage "${stageId}"`,
              stageId,
            );
          } catch (error) {
            const failure = error instanceof RuntimeFailure
              ? error.failure
              : runtimeFailure("invalid-input", "node", errorMessage(error), false, stageId, error);
            exitNode();
            return failureOutcome(failure);
          }

          let completion: NodeCompletion;
          try {
            completion = await this.executeNodeWithResume(
              graph,
              stage.node,
              nodeInput,
              root,
              invocation,
              nodeVisit,
              maxSteps,
              graphSkills,
              contextState,
              mechanismRuntime,
              hostMechanisms,
              graphMechanisms,
              resumeAttempt,
            );
            this.assertNotCancelled(root);
          } catch (error) {
            const failure = error instanceof RuntimeFailure
              ? error.failure
              : error instanceof MechanismRuntimeError
                ? runtimeFailure("mechanism-failed", error.failure.installation === "node" ? "node" : "graph", error.message, false, stageId, error)
              : isCancellationError(error, root.signal)
                ? cancelledFailure(error)
              : runtimeFailure("runtime-error", stage.node.kind === "agent" ? "agent" : "node", errorMessage(error), true, stageId, error);
            exitNode();
            return failureOutcome(failure);
          }

          try {
            const result = this.validateSchemaBoundary(
              stage.node.output,
              completion.result,
              "validation-exhausted",
              stage.node.kind === "agent" ? "agent" : "node",
              `Node output is invalid at Stage "${stageId}"`,
              stageId,
            );
            completion = Object.freeze({ result });
          } catch (error) {
            const failure = error instanceof RuntimeFailure
              ? error.failure
              : runtimeFailure("validation-exhausted", "node", errorMessage(error), false, stageId, error);
            exitNode();
            return failureOutcome(failure);
          }

          let connection: Connection | undefined;
          try {
            connection = await selectConnection(stage.route, completion);
            this.assertNotCancelled(root);
          } catch (error) {
            if (error instanceof RuntimeFailure) {
              exitNode();
              return failureOutcome(error.failure);
            }
            if (isCancellationError(error, root.signal)) {
              exitNode();
              return failureOutcome(cancelledFailure(error));
            }
            exitNode();
            return failureOutcome(runtimeFailure(
              "transition-failed",
              "route",
              `Route evaluation failed at Stage "${stageId}"`,
              true,
              stageId,
              error,
            ));
          }
          if (!connection) {
            exitNode();
            return failureOutcome(runtimeFailure(
              "no-route",
              "route",
              `No Connection matched at Stage "${stageId}"`,
              false,
              stageId,
            ));
          }
          this.eventBus.emit({
            type: "transition_selected",
            rootRunId: root.rootRunId,
            graphInvocationId: invocation.graphInvocationId,
            nodeVisitId: nodeVisit.nodeVisitId,
            stageId,
            connectionId: connection.id,
            target: connection.to,
          });

          const transitionInput = { completion } as const;
          try {
            if (connection.transition.frame) {
              frames.push(connection.transition.frame(transitionInput));
              contextState.bumpMemoryRevision();
            }
            this.assertNotCancelled(root);
            if (connection.to === "__graph_finish__") {
              const output = connection.transition.output?.(transitionInput);
              if (output === undefined) {
                throw new Error(`Finish Connection "${connection.id}" did not produce output`);
              }
              this.assertNotCancelled(root);
              const validatedOutput = this.validateSchemaBoundary(
                graph.output,
                output,
                "validation-exhausted",
                "graph",
                `Graph output is invalid for ${graph.id}@${graph.version}`,
                stageId,
              );
              exitNode();
              return completedOutcome(validatedOutput);
            }
            nodeInput = connection.transition.map?.(transitionInput) ?? completion.result;
            this.assertNotCancelled(root);
            stageId = connection.to;
            exitNode();

            // Write checkpoint at resumed node boundary
            await this.writeNodeCheckpoint(
              root,
              invocation,
              nodeVisit,
              stageId,
              nodeInput,
              frames,
              mechanismRuntime,
              hostMechanisms,
            );
          } catch (error) {
            if (error instanceof RuntimeFailure) {
              exitNode();
              return failureOutcome(error.failure);
            }
            if (isCancellationError(error, root.signal)) {
              exitNode();
              return failureOutcome(cancelledFailure(error));
            }
            exitNode();
            return failureOutcome(runtimeFailure(
              "transition-failed",
              "transition",
              `Transition "${connection.id}" failed`,
              true,
              stageId,
              error,
            ));
          }
        }
        return failureOutcome(runtimeFailure(
          "max-steps-exceeded",
          "graph",
          `Graph Invocation exceeded maxSteps ${maxSteps}`,
          false,
          stageId,
        ));
      } finally {
        this.activeGraphMechanisms.delete(invocation.graphInvocationId);
        // graphMechanisms are owned by the resume caller, not closed here.
      }
    } finally {
      this.activeInvocations.delete(invocation.graphInvocationId);
    }
  }

  private async executeNodeWithResume(
    graph: Graph,
    node: NodeDefinition,
    input: JsonValue,
    root: RootRunState,
    invocation: GraphInvocationState,
    nodeVisit: NodeVisitState,
    maxSteps: number,
    graphSkills: readonly ResolvedSkillView[],
    contextState: ContextState,
    mechanismRuntime: MechanismRuntime,
    hostMechanisms: MechanismChain,
    graphMechanisms: MechanismChain,
    resumeAttempt: number,
  ): Promise<NodeCompletion> {
    const capabilities = this.resolveNodeCapabilities(graph, nodeVisit.stageId, node, graphSkills, root, invocation);
    const nodeMechanisms = await mechanismRuntime.open("node", nodeVisit.nodeVisitId, node.mechanisms ?? [], {
      rootRunId: root.rootRunId,
      graphInvocationId: invocation.graphInvocationId,
      nodeVisitId: nodeVisit.nodeVisitId,
      stageId: nodeVisit.stageId,
    }, contextState);
    const chains = [hostMechanisms, graphMechanisms, nodeMechanisms] as const;
    try {
      await mechanismRuntime.enter(chains, "onNodeEnter");
      const { snapshot } = await contextState.materializeNode(
        nodeVisit.nodeVisitId,
        nodeVisit.stageId,
        graph.stages[nodeVisit.stageId],
        input,
        capabilities.skills,
      );
      let result: JsonValue;
      if (node.kind === "agent") {
        result = await this.runAgent(graph, node, input, root, invocation, nodeVisit, 1, maxSteps, capabilities.tools, capabilities.skills, snapshot, contextState, mechanismRuntime, chains);
      } else if (node.kind === "graph") {
        result = await this.executeGraphNode(node, input, root, invocation, maxSteps);
      } else {
        let agentIndex = 0;
        result = await node.execute({
          input: input as never,
          complete: (value) => value,
          resumeAttempt,
          rootRunId: root.rootRunId,
          nodeVisitId: nodeVisit.nodeVisitId,
          runAgent: async (agentRequest) => ({
            result: await this.runCodeAgent(
              agentRequest,
              node,
              root,
              invocation,
              nodeVisit,
              ++agentIndex,
              maxSteps,
              capabilities.tools,
              capabilities.skills,
              snapshot,
              contextState,
              mechanismRuntime,
              chains,
            ),
          }),
        }) as JsonValue;
      }
      await mechanismRuntime.nodeExit(chains, result);
      return { result };
    } catch (error) {
      await mechanismRuntime.nodeError(chains, error);
      throw error;
    } finally {
      await mechanismRuntime.close(nodeMechanisms);
    }
  }

  private assertNotCancelled(root: RootRunState): void {
    if (root.signal?.aborted) {
      throw new RuntimeFailure(runtimeFailure("cancelled", "root", "Graph execution cancelled", false));
    }
  }

  private validateSchemaBoundary(
    schema: TSchema,
    value: unknown,
    code: GraphFailure["code"],
    phase: GraphFailure["phase"],
    message: string,
    stageId?: string,
  ): JsonValue {
    let checked;
    try {
      checked = checkJsonSchemaValue(schema, value);
    } catch (error) {
      throw new RuntimeFailure(runtimeFailure(
        "invalid-graph",
        "graph",
        `Invalid JSON Schema: ${errorMessage(error)}`,
        false,
        stageId,
        error,
      ));
    }
    if (!checked.valid || checked.value === undefined) {
      throw new RuntimeFailure(runtimeFailure(
        code,
        phase,
        `${message}${checked.message ? `: ${checked.message}` : ""}`,
        false,
        stageId,
      ));
    }
    return checked.value;
  }
}

async function firstMatchingEntry<TInputSchema extends TSchema>(
  graph: Graph<TInputSchema>,
  input: SchemaValue<TInputSchema>,
) {
  for (const entry of graph.entries) {
    if (!entry.guard || await entry.guard(input)) return entry;
  }
  return undefined;
}

async function selectConnection(
  route: import("../core/graph.js").Route,
  completion: NodeCompletion,
): Promise<Connection | undefined> {
  if (route.kind === "agent-choice" && isJsonObject(completion.result)) {
    const choice = completion.result.chosen_edge_id;
    if (typeof choice === "string") return route.connections.find((connection) => connection.id === choice);
  }
  for (const connection of route.connections) {
    if (!connection.transition.guard || await connection.transition.guard(completion.result)) return connection;
  }
  return undefined;
}

function validateRouteStructure(
  route: import("../core/graph.js").Route | undefined,
  result: JsonValue,
): { readonly valid: boolean; readonly reason?: string } {
  if (!route) return { valid: true };
  if (route.connections.length === 0) return { valid: false, reason: "Route has no connections" };
  if (route.kind !== "agent-choice") return { valid: true };
  return isJsonObject(result)
    ? { valid: true }
    : { valid: false, reason: "agent-choice result must be an object" };
}

function validateAgentChoice(
  route: import("../core/graph.js").Route | undefined,
  result: JsonValue,
): { readonly valid: boolean; readonly reason?: string } {
  if (!route || route.kind !== "agent-choice") return { valid: true };
  if (!isJsonObject(result)) return { valid: false, reason: "agent-choice result must be an object" };
  const choice = result.chosen_edge_id;
  if (typeof choice !== "string" || !choice) return { valid: false, reason: "agent-choice requires result.chosen_edge_id" };
  return route.connections.some((connection) => connection.id === choice)
    ? { valid: true }
    : { valid: false, reason: `Unknown agent-choice connection: ${choice}` };
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function completedOutcome(output: JsonValue): InvocationOutcome {
  return Object.freeze({ status: "completed", output });
}

function failureOutcome(failure: GraphFailure): InvocationOutcome {
  return Object.freeze({
    status: failure.code === "cancelled" ? "cancelled" : "failed",
    failure,
  });
}

function runtimeFailure(
  code: GraphFailure["code"],
  phase: GraphFailure["phase"],
  message: string,
  retryable = false,
  stageId?: string,
  cause?: unknown,
): GraphFailure {
  return Object.freeze({ code, phase, message, retryable, stageId, cause });
}

function mapUnexpectedFailure(error: unknown, signal?: AbortSignal): GraphFailure {
  if (error instanceof MechanismRuntimeError) {
    return runtimeFailure("mechanism-failed", error.failure.installation === "node" ? "node" : "graph", error.message, false, undefined, error);
  }
  if (error instanceof RuntimeFailure) return error.failure;
  if (isCancellationError(error, signal)) return cancelledFailure(error);
  if (error instanceof InvocationBudgetExceededError) {
    return runtimeFailure("max-steps-exceeded", "root", error.message, false, undefined, error);
  }
  return runtimeFailure("runtime-error", "root", errorMessage(error), true, undefined, error);
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function cancelledFailure(cause?: unknown): GraphFailure {
  return runtimeFailure("cancelled", "root", "Graph execution cancelled", false, undefined, cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkpointOrder(checkpoint: CheckpointNodeBoundary): number {
  if (checkpoint.createdAt) return Date.parse(checkpoint.createdAt);
  // Legacy v1 checkpoints did not carry ordering metadata. They remain readable,
  // but tie deterministically without pretending their UUID encodes chronology.
  return 0;
}

function stableResumeNodeVisitId(checkpoint: CheckpointNodeBoundary): string {
  return `resume-${checkpoint.checkpointId}-${checkpoint.next.stageId}`;
}
