import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ContextContribution, ContextContributionHandle, ContextLifetime } from "../core/context.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import type {
  Mechanism,
  MechanismCompletionDecision,
  MechanismContext,
  MechanismDecisionTrace,
  MechanismFailurePolicy,
  MechanismHookName,
  MechanismInstallation,
  MechanismScope,
} from "../core/mechanism.js";

const execFileAsync = promisify(execFile);

export interface MechanismRuntimeOptions {
  readonly hookTimeoutMs?: number;
  readonly execRoot?: string;
  readonly execTimeoutMs?: number;
  readonly execMaxOutputBytes?: number;
  readonly allowExecOutsideRoot?: boolean;
  readonly pi?: unknown;
}

export interface MechanismFailureRecord {
  readonly mechanismName: string;
  readonly installation: MechanismInstallation;
  readonly hook: MechanismHookName | "createState" | "cleanup";
  readonly policy: MechanismFailurePolicy;
  readonly message: string;
  readonly error: unknown;
  readonly scopeId: string;
}

export class MechanismRuntimeError extends Error {
  constructor(readonly failure: MechanismFailureRecord) {
    super(failure.message);
    this.name = "MechanismRuntimeError";
  }
}

interface Invocation {
  readonly definition: Mechanism;
  readonly installation: MechanismInstallation;
  readonly context: MechanismContext;
  readonly scope: ManagedScope;
}

export interface MechanismChain {
  readonly invocations: readonly Invocation[];
}

export class MechanismRuntime {
  private readonly options: Required<Omit<MechanismRuntimeOptions, "pi">> & Pick<MechanismRuntimeOptions, "pi">;
  private readonly activeNames: string[] = [];
  private readonly decisions: MechanismDecisionTrace[] = [];
  private readonly failures: MechanismFailureRecord[] = [];
  private unmanagedWarningEmitted = false;
  private readonly contributions = new Map<string, ContextContribution>();
  private agentRunHandles: Array<{ dispose(): void }> | null = null;
  private naturalLifetime: ContextLifetime | undefined;

  constructor(options: MechanismRuntimeOptions = {}, private readonly warn?: (message: string) => void) {
    this.options = {
      hookTimeoutMs: options.hookTimeoutMs ?? 30_000,
      execRoot: path.resolve(options.execRoot ?? process.cwd()),
      execTimeoutMs: options.execTimeoutMs ?? 30_000,
      execMaxOutputBytes: options.execMaxOutputBytes ?? 64 * 1024,
      allowExecOutsideRoot: options.allowExecOutsideRoot ?? false,
      pi: options.pi,
    };
  }

  get decisionTrace(): readonly MechanismDecisionTrace[] { return Object.freeze([...this.decisions]); }
  get failureTrace(): readonly MechanismFailureRecord[] { return Object.freeze([...this.failures]); }
  get contextContributions(): readonly ContextContribution[] { return Object.freeze([...this.contributions.values()]); }

  async open(
    installation: MechanismInstallation,
    scopeId: string,
    definitions: readonly Mechanism[],
    identity: { rootRunId: string; graphInvocationId?: string; nodeVisitId?: string; stageId?: string },
    _contextState?: import("../core/context.js").ContextState,
  ): Promise<MechanismChain> {
    this.validateDuplicates(definitions);
    const invocations: Invocation[] = [];
    try {
      for (const definition of definitions) {
        if (!definition.allowMultiple && this.activeNames.includes(definition.name)) {
          throw this.error(definition, installation, "createState", scopeId, new Error(`Mechanism is already installed in the active chain: ${definition.name}`));
        }
        let state: JsonValue;
        try {
          state = definition.createState?.() ?? {};
          if (!isJsonValue(state)) throw new Error("Mechanism state must be JSON-compatible");
        } catch (error) {
          throw this.error(definition, installation, "createState", scopeId, error);
        }
        const scope = new ManagedScope(scopeId, installation);
        const context = this.createContext(definition, installation, identity, state, scope);
        invocations.push({ definition, installation, context, scope });
        this.activeNames.push(definition.name);
      }
      return Object.freeze({ invocations: Object.freeze(invocations) });
    } catch (error) {
      await this.close(Object.freeze({ invocations: Object.freeze(invocations) }));
      throw error;
    }
  }

  async beforeAgentRun(chains: readonly MechanismChain[], agentRunId: string, prompt: string): Promise<void> {
    this.agentRunHandles = [];
    for (const invocation of flatten(chains)) {
      const hook = invocation.definition.beforeAgentRun;
      if (!hook) continue;
      this.naturalLifetime = "agent-run";
      try {
        await this.control(invocation, "beforeAgentRun", () => hook(Object.freeze({ ...invocation.context, agentRunId, prompt })));
      } finally {
        this.naturalLifetime = undefined;
      }
    }
  }

  async afterAgentRun(chains: readonly MechanismChain[], agentRunId: string): Promise<void> {
    for (const invocation of [...flatten(chains)].reverse()) {
      const hook = invocation.definition.afterAgentRun;
      if (!hook) continue;
      await this.observeInvocation(invocation, "afterAgentRun", () => hook(Object.freeze({ ...invocation.context, agentRunId })));
    }
    for (const handle of this.agentRunHandles ?? []) handle.dispose();
    this.agentRunHandles = null;
  }

  async enter(chains: readonly MechanismChain[], hookName: "onRootEnter" | "onGraphEnter" | "onNodeEnter"): Promise<void> {
    for (const invocation of flatten(chains)) {
      const hook = invocation.definition[hookName] as ((ctx: MechanismContext) => void | Promise<void>) | undefined;
      if (hook) await this.observeInvocation(invocation, hookName, () => hook(invocation.context));
    }
  }

  async validateCompletion(chains: readonly MechanismChain[], agentRunId: string, completion: JsonValue): Promise<MechanismCompletionDecision> {
    for (const invocation of [...flatten(chains)].reverse()) {
      const hook = invocation.definition.validateCompletion;
      if (!hook) continue;
      const decision = await this.control(invocation, "validateCompletion", () => hook(Object.freeze({ ...invocation.context, agentRunId, completion })));
      this.decisions.push(Object.freeze({
        mechanismName: invocation.definition.name,
        hook: "validateCompletion",
        decision: decision.action,
        reason: "reason" in decision ? decision.reason : undefined,
        timestamp: Date.now(),
      }));
      if (decision.action !== "allow") return decision;
    }
    return { action: "allow" };
  }

  async nodeExit(chains: readonly MechanismChain[], completion: JsonValue): Promise<void> {
    for (const invocation of [...flatten(chains)].reverse()) {
      const hook = invocation.definition.onNodeExit;
      if (hook) await this.observeInvocation(invocation, "onNodeExit", () => hook(Object.freeze({ ...invocation.context, completion })));
    }
  }

  async nodeError(chains: readonly MechanismChain[], error: unknown): Promise<void> {
    for (const invocation of [...flatten(chains)].reverse()) {
      const hook = invocation.definition.onNodeError;
      if (hook) await this.observeInvocation(invocation, "onNodeError", () => hook(Object.freeze({ ...invocation.context, error })));
    }
  }

  async graphExit(chains: readonly MechanismChain[], error?: unknown): Promise<void> {
    for (const invocation of [...flatten(chains)].reverse()) {
      const hook = error === undefined ? invocation.definition.onGraphExit : invocation.definition.onGraphError;
      const name = error === undefined ? "onGraphExit" : "onGraphError";
      if (hook) await this.observeInvocation(invocation, name, () => hook(Object.freeze({ ...invocation.context, ...(error === undefined ? {} : { error }) }) as never));
    }
  }

  async rootExit(chain: MechanismChain): Promise<void> {
    for (const invocation of [...chain.invocations].reverse()) {
      const hook = invocation.definition.onRootExit;
      if (hook) await this.observeInvocation(invocation, "onRootExit", () => hook(invocation.context));
    }
  }

  async close(chain: MechanismChain): Promise<void> {
    for (const invocation of [...chain.invocations].reverse()) {
      const errors = await invocation.scope.close();
      for (const error of errors) this.record(invocation, "cleanup", error);
      const index = this.activeNames.lastIndexOf(invocation.definition.name);
      if (index >= 0) this.activeNames.splice(index, 1);
    }
  }

  private async observe(chain: MechanismChain, hookName: "onRootEnter" | "onGraphEnter" | "onNodeEnter"): Promise<void> {
    for (const invocation of chain.invocations) {
      const hook = invocation.definition[hookName] as ((ctx: MechanismContext) => void | Promise<void>) | undefined;
      if (hook) await this.observeInvocation(invocation, hookName, () => hook(invocation.context));
    }
  }

  private async observeInvocation(invocation: Invocation, hook: MechanismHookName, run: () => unknown | Promise<unknown>): Promise<void> {
    try { await withTimeout(Promise.resolve(run()), this.options.hookTimeoutMs, hook); }
    catch (error) { this.record(invocation, hook, error); }
  }

  private async control<T>(invocation: Invocation, hook: MechanismHookName, run: () => T | Promise<T>): Promise<T> {
    try { return await withTimeout(Promise.resolve(run()), this.options.hookTimeoutMs, hook); }
    catch (error) { throw this.error(invocation.definition, invocation.installation, hook, invocation.scope.scopeId, error); }
  }

  private createContext(
    definition: Mechanism,
    installation: MechanismInstallation,
    identity: { rootRunId: string; graphInvocationId?: string; nodeVisitId?: string; stageId?: string },
    state: JsonValue,
    scope: ManagedScope,
  ): MechanismContext {
    const maxLifetime: ContextLifetime = installation === "host" ? "root-run" : installation === "graph" ? "graph-invocation" : "node-visit";
    const defaultLifetime = installation === "host" ? "root-run" : installation === "graph" ? "graph-invocation" : "node-visit";
    const context = {
      add: (id: string, content: import("../core/graph.js").ContextContent, options: { lifetime?: ContextLifetime; retention?: import("../core/context.js").ContextRetention } = {}) => {
        const lifetime = options.lifetime ?? this.naturalLifetime ?? defaultLifetime;
        if (!lifetimeAllowed(lifetime, maxLifetime)) throw new Error(`${installation} Mechanism cannot create ${lifetime} contribution`);
        const contributionId = `${scope.scopeId}:${definition.name}:${id}`;
        if (this.contributions.has(contributionId)) throw new Error(`Context contribution already exists: ${contributionId}`);
        const contribution: ContextContribution = Object.freeze({
          id: contributionId,
          owner: installation,
          scopeId: scope.scopeId,
          lifetime,
          retention: options.retention ?? "sticky",
          content,
        });
        this.contributions.set(contributionId, contribution);
        let active = true;
        const handle: ContextContributionHandle = Object.freeze({
          id: contributionId,
          update: (next: import("../core/graph.js").ContextContent) => {
            if (!active) throw new Error(`Context contribution is disposed: ${contributionId}`);
            this.contributions.set(contributionId, Object.freeze({ ...contribution, content: next }));
          },
          dispose: () => {
            if (!active) return;
            active = false;
            this.contributions.delete(contributionId);
          },
        });
        scope.view.onCleanup(() => handle.dispose());
        if (lifetime === "agent-run") this.agentRunHandles?.push(handle);
        return handle;
      },
    };
    const result: Record<string, unknown> = {
      ...identity,
      state,
      scope: scope.view,
      context: Object.freeze(context),
      exec: Object.freeze({ run: (file: string, args?: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => this.exec(file, args, options) }),
    };
    if (this.options.pi !== undefined) Object.defineProperty(result, "pi", {
      enumerable: true,
      get: () => {
        if (!this.unmanagedWarningEmitted) {
          this.unmanagedWarningEmitted = true;
          this.warn?.("Mechanism accessed unmanaged ctx.pi; scope, replay, and cleanup guarantees do not apply");
        }
        return this.options.pi;
      },
    });
    return Object.freeze(result) as unknown as MechanismContext;
  }

  private async exec(file: string, args: readonly string[] = [], options: { cwd?: string; timeoutMs?: number } = {}) {
    const cwd = path.resolve(options.cwd ?? this.options.execRoot);
    if (!this.options.allowExecOutsideRoot && !within(this.options.execRoot, cwd)) throw new Error("Mechanism exec cwd is outside execRoot");
    try {
      const result = await execFileAsync(file, [...args], { cwd, timeout: options.timeoutMs ?? this.options.execTimeoutMs, maxBuffer: this.options.execMaxOutputBytes * 2 });
      return output(0, result.stdout, result.stderr, this.options.execMaxOutputBytes);
    } catch (error) {
      const value = error as { code?: number; stdout?: string; stderr?: string };
      return output(typeof value.code === "number" ? value.code : 1, value.stdout ?? "", value.stderr ?? String(error), this.options.execMaxOutputBytes);
    }
  }

  private validateDuplicates(definitions: readonly Mechanism[]): void {
    const names = new Set<string>();
    for (const definition of definitions) {
      if (!definition.name.trim()) throw new Error("Mechanism name is required");
      if (!definition.allowMultiple && names.has(definition.name)) throw new Error(`Duplicate Mechanism installation: ${definition.name}`);
      names.add(definition.name);
    }
  }

  private record(invocation: Invocation, hook: MechanismHookName | "cleanup", error: unknown): MechanismFailureRecord {
    const failure = this.failure(invocation.definition, invocation.installation, hook, invocation.scope.scopeId, error);
    this.failures.push(failure);
    return failure;
  }

  private error(definition: Mechanism, installation: MechanismInstallation, hook: MechanismHookName | "createState", scopeId: string, error: unknown): MechanismRuntimeError {
    const failure = this.failure(definition, installation, hook, scopeId, error);
    this.failures.push(failure);
    return new MechanismRuntimeError(failure);
  }

  private failure(definition: Mechanism, installation: MechanismInstallation, hook: MechanismHookName | "createState" | "cleanup", scopeId: string, error: unknown): MechanismFailureRecord {
    return Object.freeze({
      mechanismName: definition.name,
      installation,
      hook,
      policy: definition.failurePolicy ?? (installation === "node" ? "fail-node" : "fail-graph"),
      message: `Mechanism "${definition.name}" ${hook} failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
      scopeId,
    });
  }
}

class ManagedScope {
  private active = true;
  private readonly controller = new AbortController();
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  readonly view: MechanismScope;
  constructor(readonly scopeId: string, installation: MechanismInstallation) {
    this.view = Object.freeze({
      scopeId, installation, signal: this.controller.signal,
      isActive: () => this.active,
      onCleanup: (cleanup: () => void | Promise<void>) => {
        if (!this.active) throw new Error("Mechanism scope is closed");
        this.cleanups.push(cleanup);
      },
    });
  }
  async close(): Promise<unknown[]> {
    if (!this.active) return [];
    this.active = false;
    this.controller.abort();
    const errors: unknown[] = [];
    for (const cleanup of [...this.cleanups].reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    return errors;
  }
}

function flatten(chains: readonly MechanismChain[]): Invocation[] { return chains.flatMap((chain) => [...chain.invocations]); }
function lifetimeAllowed(requested: ContextLifetime, maximum: ContextLifetime): boolean {
  const order: ContextLifetime[] = ["agent-run", "node-visit", "graph-invocation", "root-run"];
  return order.indexOf(requested) <= order.indexOf(maximum);
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function output(exitCode: number, stdout: string, stderr: string, max: number) {
  const truncate = (value: string) => {
    const buffer = Buffer.from(value, "utf8");
    return buffer.length <= max ? { value, truncated: false } : { value: buffer.subarray(0, max).toString("utf8"), truncated: true };
  };
  const out = truncate(stdout); const err = truncate(stderr);
  return Object.freeze({ exitCode, stdout: out.value, stderr: err.value, truncated: out.truncated || err.truncated });
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, hook: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${hook} timed out after ${timeoutMs}ms`)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
