import type { ContextContent } from "./graph.js";
import type { ContextLifetime, ContextRetention, ContextContributionHandle } from "./context.js";
import type { JsonValue } from "./json.js";

export type MechanismInstallation = "host" | "graph" | "node";
export type MechanismFailurePolicy = "continue" | "fail-node" | "fail-graph";
export type MechanismHookName =
  | "onRootEnter" | "onRootExit"
  | "onGraphEnter" | "onGraphExit" | "onGraphError"
  | "onNodeEnter" | "onNodeExit" | "onNodeError"
  | "beforeAgentRun" | "afterAgentRun" | "validateCompletion";

export interface MechanismScope {
  readonly scopeId: string;
  readonly installation: MechanismInstallation;
  readonly signal: AbortSignal;
  isActive(): boolean;
  onCleanup(cleanup: () => void | Promise<void>): void;
}

export interface MechanismContextApi {
  add(
    id: string,
    content: ContextContent,
    options?: { readonly lifetime?: ContextLifetime; readonly retention?: ContextRetention },
  ): ContextContributionHandle;
}

export interface MechanismExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface MechanismExec {
  run(file: string, args?: readonly string[], options?: { readonly cwd?: string; readonly timeoutMs?: number }): Promise<MechanismExecResult>;
}

export interface MechanismDecisionTrace {
  readonly mechanismName: string;
  readonly hook: MechanismHookName;
  readonly decision: "allow" | "reject" | "fail-node" | "fail-graph";
  readonly reason?: string;
  readonly timestamp: number;
}

export interface MechanismContext<TState = JsonValue> {
  readonly rootRunId: string;
  readonly graphInvocationId?: string;
  readonly nodeVisitId?: string;
  readonly agentRunId?: string;
  readonly stageId?: string;
  readonly state: TState;
  readonly scope: MechanismScope;
  readonly context: MechanismContextApi;
  readonly exec: MechanismExec;
  /** Direct Host adapter access is unmanaged and generates a runtime warning when read. */
  readonly pi?: unknown;
}

export type MechanismCompletionDecision =
  | { readonly action: "allow"; readonly verifiedResult?: JsonValue }
  | { readonly action: "reject" | "fail-node" | "fail-graph"; readonly reason: string };

export interface Mechanism<TState extends JsonValue = JsonValue> {
  readonly name: string;
  readonly allowMultiple?: boolean;
  readonly failurePolicy?: MechanismFailurePolicy;
  createState?(): TState;
  snapshot?(state: Readonly<TState>): JsonValue;
  restore?(snapshot: JsonValue): TState;
  onRootEnter?(ctx: MechanismContext<TState>): void | Promise<void>;
  onRootExit?(ctx: MechanismContext<TState>): void | Promise<void>;
  onGraphEnter?(ctx: MechanismContext<TState>): void | Promise<void>;
  onGraphExit?(ctx: MechanismContext<TState>): void | Promise<void>;
  onGraphError?(ctx: MechanismContext<TState> & { readonly error: unknown }): void | Promise<void>;
  onNodeEnter?(ctx: MechanismContext<TState>): void | Promise<void>;
  onNodeExit?(ctx: MechanismContext<TState> & { readonly completion: JsonValue }): void | Promise<void>;
  onNodeError?(ctx: MechanismContext<TState> & { readonly error: unknown }): void | Promise<void>;
  beforeAgentRun?(ctx: MechanismContext<TState> & { readonly prompt: string }): void | Promise<void>;
  afterAgentRun?(ctx: MechanismContext<TState>): void | Promise<void>;
  validateCompletion?(ctx: MechanismContext<TState> & { readonly completion: JsonValue }): MechanismCompletionDecision | Promise<MechanismCompletionDecision>;
}

export function defineMechanism<TState extends JsonValue>(mechanism: Mechanism<TState>): Mechanism<TState> {
  if (!mechanism.name.trim()) throw new Error("Mechanism name is required");
  return Object.freeze({ ...mechanism });
}
