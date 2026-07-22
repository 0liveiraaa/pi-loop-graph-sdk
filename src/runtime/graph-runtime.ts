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
import type { Mechanism } from "../core/mechanism.js";
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
          connection = await selectConnection(stage.route.connections, completion);
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
      if (graphMechanisms) {
        await request.mechanismRuntime.graphExit([request.hostMechanisms, graphMechanisms], graphError);
        await request.mechanismRuntime.close(graphMechanisms);
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
        result = await this.runAgent(
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

  private async runAgent(
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
    if (!this.host.runAgent) throw new RuntimeFailure(runtimeFailure("host-unavailable", "host", "Agent Node requires host.runAgent", false, nodeVisit.stageId));
    const state = this.beginAgent(root, invocation, nodeVisit, index);
    try {
      await mechanismRuntime.beforeAgentRun(mechanismChains, state.agentRunId, node.prompt ?? node.subGoal);
      return await this.host.runAgent(node, input, this.createAgentContext(
        root,
        invocation,
        nodeVisit,
        state,
        maxSteps,
        tools,
        skills,
        contextState.refreshSnapshot(snapshot, state.agentRunId),
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
    if (!this.host.runAgentFromCode) throw new RuntimeFailure(runtimeFailure("host-unavailable", "host", "Code Node runAgent requires host.runAgentFromCode", false, nodeVisit.stageId));
    const state = this.beginAgent(root, invocation, nodeVisit, index);
    try {
      await mechanismRuntime.beforeAgentRun(mechanismChains, state.agentRunId, request.prompt);
      return await this.host.runAgentFromCode(request, node, this.createAgentContext(
        root,
        invocation,
        nodeVisit,
        state,
        maxSteps,
        tools,
        skills,
        contextState.refreshSnapshot(snapshot, state.agentRunId),
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
  connections: readonly Connection[],
  completion: NodeCompletion,
): Promise<Connection | undefined> {
  for (const connection of connections) {
    if (!connection.transition.guard || await connection.transition.guard(completion.result)) return connection;
  }
  return undefined;
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
