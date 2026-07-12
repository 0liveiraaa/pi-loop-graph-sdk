import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import Schema from "typebox/schema";
import type {
  AgentRunRequest,
  AgentInstance,
  CompletionDecision,
  Mechanism,
  MechanismAgentRunContext,
  MechanismContext,
  MechanismDecisionLog,
  MechanismDecisionTraceEntry,
  MechanismCompletionContext,
  MechanismExec,
  MechanismEvents,
  MechanismEventSubscription,
  MechanismFailurePolicy,
  MechanismScope,
  MechanismToolCallEvent,
  MechanismToolResultEvent,
  MechanismToolStartEvent,
  MechanismTurnEndEvent,
  MechanismTurnStartEvent,
  ToolCallDecision,
  ToolResultDecision,
} from "../type.js";
import type { NodeScopeDescriptor } from "../runtime.js";

export interface MechanismCleanupError {
  mechanismName: string;
  error: unknown;
}

export type MechanismFailurePhase =
  | "createState"
  | "onNodeEnter"
  | "onNodeExit"
  | "onNodeError"
  | "beforeAgentRun"
  | "onTurnStart"
  | "onTurnEnd"
  | "onToolStart"
  | "onToolResult"
  | "beforeToolCall"
  | "afterToolResult"
  | "validateCompletion"
  | "tool_result"
  | "turn_start"
  | "turn_end";

export interface MechanismFailureRecord {
  mechanismName: string;
  phase: MechanismFailurePhase;
  policy: MechanismFailurePolicy;
  error: unknown;
  reason: string;
  scopeId: string;
}

export interface MechanismStateResolution {
  state: unknown;
  initializationFailed: boolean;
  initializationError?: unknown;
}

export interface MechanismHookInvocation {
  mechanism: Mechanism<any>;
  context: MechanismContext<any>;
  initializationFailure?: unknown;
}

export interface MechanismRunStartResult {
  blocked: boolean;
  reason?: string;
}

export interface MechanismRuntimeOptions {
  execRoot?: string;
  execTimeoutMs?: number;
  execMaxOutputBytes?: number;
  allowExecOutsideRoot?: boolean;
  eventMaxBytes?: number;
  completionValidationTimeoutMs?: number;
}

export type MechanismCompletionGateResult =
  | {
      action: "allow";
      verifiedResult?: Readonly<{ checks: readonly import("../type.js").MechanismVerifiedResultEntry[] }>;
    }
  | { action: "reject" | "fail-node" | "fail-graph"; reason: string };

interface MechanismStateRecord extends MechanismStateResolution {}

/**
 * mechanism state 的唯一所有者：每个 AgentInstance、每个 mechanism 对象一份。
 * WeakMap 不延长 instance 或 mechanism definition 的生命周期。
 */
export class MechanismStateStore {
  private readonly states = new WeakMap<
    AgentInstance,
    WeakMap<object, MechanismStateRecord>
  >();

  resolve(
    instance: AgentInstance,
    mechanism: Mechanism,
  ): MechanismStateResolution {
    let instanceStates = this.states.get(instance);
    if (!instanceStates) {
      instanceStates = new WeakMap();
      this.states.set(instance, instanceStates);
    }

    const existing = instanceStates.get(mechanism);
    if (existing) return existing;

    let record: MechanismStateRecord;
    try {
      record = {
        state: mechanism.createState ? mechanism.createState() : {},
        initializationFailed: false,
      };
    } catch (initializationError) {
      record = { state: {}, initializationFailed: true, initializationError };
    }
    instanceStates.set(mechanism, record);
    return record;
  }
}

type Cleanup = () => void | Promise<void>;

/** 一个 mechanism 在单次 node visit 内拥有的托管生命周期。 */
class MechanismInvocation {
  private active = true;
  private readonly controller = new AbortController();
  private readonly cleanups: Cleanup[] = [];

  readonly scope: MechanismScope;

  constructor(
    readonly mechanismName: string,
    descriptor: NodeScopeDescriptor,
    runtimeScopeIsCurrent: () => boolean,
  ) {
    this.scope = Object.freeze({
      scopeId: descriptor.scopeId,
      visit: descriptor.visit,
      signal: this.controller.signal,
      isActive: () => this.active && runtimeScopeIsCurrent(),
      onCleanup: (cleanup: Cleanup) => {
        if (!this.active) {
          throw new Error(`mechanism ${this.mechanismName} 的 scope 已失效，不能再注册 cleanup`);
        }
        this.cleanups.push(cleanup);
      },
    });
  }

  async close(): Promise<MechanismCleanupError[]> {
    if (!this.active) return [];
    this.active = false;
    this.controller.abort();

    const errors: MechanismCleanupError[] = [];
    for (let index = this.cleanups.length - 1; index >= 0; index--) {
      try {
        await this.cleanups[index]();
      } catch (error) {
        errors.push({ mechanismName: this.mechanismName, error });
      }
    }
    this.cleanups.length = 0;
    return errors;
  }
}

/** 同一 node visit 中全部 mechanism invocation 的所有者。 */
export class MechanismInvocationGroup {
  private readonly invocations: MechanismInvocation[] = [];
  private closed = false;

  constructor(
    private readonly descriptor: NodeScopeDescriptor,
    private readonly runtimeScopeIsCurrent: () => boolean,
  ) {}

  createScope(mechanismName: string): MechanismScope {
    if (this.closed) throw new Error("mechanism invocation group 已关闭");
    const invocation = new MechanismInvocation(
      mechanismName,
      this.descriptor,
      this.runtimeScopeIsCurrent,
    );
    this.invocations.push(invocation);
    return invocation.scope;
  }

  async close(): Promise<MechanismCleanupError[]> {
    if (this.closed) return [];
    this.closed = true;
    const errors: MechanismCleanupError[] = [];
    for (let index = this.invocations.length - 1; index >= 0; index--) {
      errors.push(...await this.invocations[index].close());
    }
    this.invocations.length = 0;
    return errors;
  }
}

type SupportedEventName = "tool_result" | "turn_start" | "turn_end";

interface SupportedEventMap {
  tool_result: MechanismToolResultEvent;
  turn_start: MechanismTurnStartEvent;
  turn_end: MechanismTurnEndEvent;
}

interface EventSubscriber {
  eventName: SupportedEventName;
  mechanismName: string;
  policy: MechanismFailurePolicy;
  scope: MechanismScope;
  handler: (event: unknown) => void | Promise<void>;
  disposed: boolean;
}

class BrokerSubscription implements MechanismEventSubscription {
  constructor(
    private readonly subscriber: EventSubscriber,
    private readonly remove: (subscriber: EventSubscriber) => void,
  ) {}

  get disposed(): boolean {
    return this.subscriber.disposed;
  }

  dispose(): void {
    if (this.subscriber.disposed) return;
    this.subscriber.disposed = true;
    this.remove(this.subscriber);
  }
}

/**
 * pi 每类事件只注册一个底层 handler；node visit 内的订阅由 scope 托管。
 * handler 控制性失败先记录，随后由图循环在安全检查点消费。
 */
export class MechanismEventBroker {
  private readonly subscribers = new Map<SupportedEventName, EventSubscriber[]>([
    ["tool_result", []],
    ["turn_start", []],
    ["turn_end", []],
  ]);
  private readonly pendingFailures: MechanismFailureRecord[] = [];
  private readonly decisionTraces = new Map<string, MechanismDecisionTraceEntry[]>();
  private activeRun: {
    agentRunId: number;
    invocations: readonly MechanismHookInvocation[];
  } | null = null;
  private readonly pi: ExtensionAPI;
  private readonly options: Required<MechanismRuntimeOptions>;

  constructor(
    pi: ExtensionAPI,
    private readonly reportFailure: (failure: MechanismFailureRecord) => void,
    options: MechanismRuntimeOptions = {},
  ) {
    this.pi = pi;
    this.options = {
      execRoot: path.resolve(options.execRoot ?? process.cwd()),
      execTimeoutMs: options.execTimeoutMs ?? 30_000,
      execMaxOutputBytes: options.execMaxOutputBytes ?? 64 * 1024,
      allowExecOutsideRoot: options.allowExecOutsideRoot ?? false,
      eventMaxBytes: options.eventMaxBytes ?? 64 * 1024,
      completionValidationTimeoutMs: options.completionValidationTimeoutMs ?? 60_000,
    };
    for (const [name, value] of Object.entries({
      execTimeoutMs: this.options.execTimeoutMs,
      execMaxOutputBytes: this.options.execMaxOutputBytes,
      eventMaxBytes: this.options.eventMaxBytes,
      completionValidationTimeoutMs: this.options.completionValidationTimeoutMs,
    })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`MechanismRuntimeOptions.${name} 必须是正整数`);
      }
    }
    pi.on("tool_call", async (event) => this.handleToolCall(event));
    pi.on("tool_execution_start", async (event) => {
      const run = this.activeRun;
      if (!run) return;
      const snapshot = Object.freeze({
        ...snapshotEvent(event),
        agentRunId: run.agentRunId,
      }) as MechanismToolStartEvent;
      await this.invokeObservationHook("onToolStart", "onToolStart", snapshot);
    });
    pi.on("tool_result", async (event) => {
      return this.handleToolResult(event);
    });
    pi.on("turn_start", async (event) => {
      const agentRunId = this.activeRun?.agentRunId ?? null;
      const snapshot = Object.freeze({ ...snapshotEvent(event), agentRunId }) as MechanismTurnStartEvent;
      await this.dispatch("turn_start", snapshot);
      if (agentRunId !== null) await this.invokeObservationHook("onTurnStart", "onTurnStart", snapshot);
    });
    pi.on("turn_end", async (event) => {
      const agentRunId = this.activeRun?.agentRunId ?? null;
      const snapshot = Object.freeze({ ...snapshotEvent(event), agentRunId }) as MechanismTurnEndEvent;
      await this.dispatch("turn_end", snapshot);
      if (agentRunId !== null) await this.invokeObservationHook("onTurnEnd", "onTurnEnd", snapshot);
    });
  }

  createExec(scope: MechanismScope): MechanismExec {
    return Object.freeze({
      run: async (
        command: string,
        args: readonly string[] = [],
        runOptions: import("../type.js").MechanismExecRunOptions = {},
      ) => {
        if (!scope.isActive()) throw new Error("mechanism scope 已失效，不能执行命令");
        const timeout = runOptions.timeoutMs ?? this.options.execTimeoutMs;
        const maxOutputBytes = runOptions.maxOutputBytes ?? this.options.execMaxOutputBytes;
        if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("exec timeoutMs 必须是正数");
        if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
          throw new Error("exec maxOutputBytes 必须是正整数");
        }
        const cwd = path.resolve(runOptions.cwd ?? this.options.execRoot);
        if (!this.options.allowExecOutsideRoot && !isWithinPath(this.options.execRoot, cwd)) {
          throw new Error(`exec cwd 超出受控根目录: ${cwd}`);
        }
        const result = await this.pi.exec(command, [...args], {
          cwd,
          timeout,
          signal: scope.signal,
        });
        const stdout = truncateUtf8(result.stdout, maxOutputBytes);
        const stderr = truncateUtf8(result.stderr, maxOutputBytes);
        return Object.freeze({
          stdout: stdout.value,
          stderr: stderr.value,
          code: result.code,
          killed: result.killed,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      },
    });
  }

  createDecisionLog(scope: MechanismScope): MechanismDecisionLog {
    if (!this.decisionTraces.has(scope.scopeId)) this.decisionTraces.set(scope.scopeId, []);
    scope.onCleanup(() => { this.decisionTraces.delete(scope.scopeId); });
    return Object.freeze({
      list: () => Object.freeze([...(this.decisionTraces.get(scope.scopeId) ?? [])]),
    });
  }

  async beginAgentRun(
    agentRunId: number,
    request: AgentRunRequest,
    invocations: readonly MechanismHookInvocation[],
  ): Promise<MechanismRunStartResult> {
    if (this.activeRun) throw new Error("同一 Session 不支持重叠的 runAgent mechanism 生命周期");
    this.activeRun = { agentRunId, invocations };
    const requestView = snapshotEvent({
      prompt: request.prompt,
      ...(request.skill === undefined ? {} : { skill: request.skill }),
      ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    });
    for (const invocation of invocations) {
      if (invocation.initializationFailure || !invocation.mechanism.beforeAgentRun) continue;
      try {
        const context: MechanismAgentRunContext = Object.freeze({
          ...invocation.context,
          agentRunId,
          request: requestView,
        });
        await invocation.mechanism.beforeAgentRun(context);
      } catch (error) {
        const failure = this.recordHookFailure(invocation, "beforeAgentRun", error);
        if (failure.policy !== "continue") return { blocked: true, reason: failure.reason };
      }
    }
    return { blocked: false };
  }

  endAgentRun(agentRunId: number): void {
    if (this.activeRun?.agentRunId === agentRunId) this.activeRun = null;
  }

  async validateCompletion(
    agentRunId: number,
    completion: import("../type.js").NodeCompletion,
  ): Promise<MechanismCompletionGateResult> {
    const run = this.activeRun;
    if (!run || run.agentRunId !== agentRunId || completion.status !== "ok") {
      return { action: "allow" };
    }
    const checks: import("../type.js").MechanismVerifiedResultEntry[] = [];
    const completionView = Object.freeze({
      nodeId: completion.nodeId,
      status: completion.status,
      result: snapshotEvent(completion.result),
    });
    for (const invocation of run.invocations) {
      const hook = invocation.mechanism.validateCompletion;
      if (invocation.initializationFailure || !hook) continue;
      let decision: CompletionDecision;
      try {
        const context: MechanismCompletionContext = Object.freeze({
          ...invocation.context,
          agentRunId,
          completion: completionView,
        });
        decision = await withTimeoutAndSignal(
          Promise.resolve(hook(context)),
          this.options.completionValidationTimeoutMs,
          invocation.context.scope.signal,
          `mechanism "${invocation.mechanism.name}" completion 验收超时`,
        );
      } catch (error) {
        const failure = this.recordHookFailure(invocation, "validateCompletion", error);
        if (failure.policy === "continue") continue;
        return {
          action: failure.policy === "fail-graph" ? "fail-graph" : "fail-node",
          reason: failure.reason,
        };
      }
      if (decision.action === "allow") {
        if (decision.verifiedResult) {
          checks.push(Object.freeze({
            mechanismName: invocation.mechanism.name,
            result: snapshotEvent(decision.verifiedResult),
          }));
        }
        continue;
      }
      if (decision.action === "reject") {
        return { action: "reject", reason: decision.reason };
      }
      const failure = this.recordCompletionDecisionFailure(invocation, decision);
      return { action: decision.action, reason: failure.reason };
    }
    if (checks.length === 0) return { action: "allow" };
    return {
      action: "allow",
      verifiedResult: Object.freeze({ checks: Object.freeze(checks) }),
    };
  }

  createEvents(
    mechanismName: string,
    policy: MechanismFailurePolicy,
    scope: MechanismScope,
  ): MechanismEvents {
    return Object.freeze({
      onToolResult: (handler: (event: MechanismToolResultEvent) => void | Promise<void>) =>
        this.subscribe("tool_result", mechanismName, policy, scope, handler),
      onTurnStart: (handler: (event: MechanismTurnStartEvent) => void | Promise<void>) =>
        this.subscribe("turn_start", mechanismName, policy, scope, handler),
      onTurnEnd: (handler: (event: MechanismTurnEndEvent) => void | Promise<void>) =>
        this.subscribe("turn_end", mechanismName, policy, scope, handler),
    });
  }

  consumeControlFailures(scopeId: string): MechanismFailureRecord[] {
    const consumed: MechanismFailureRecord[] = [];
    for (let index = this.pendingFailures.length - 1; index >= 0; index--) {
      if (this.pendingFailures[index].scopeId !== scopeId) continue;
      consumed.unshift(this.pendingFailures[index]);
      this.pendingFailures.splice(index, 1);
    }
    return consumed;
  }

  private async handleToolCall(event: ToolCallEvent): Promise<{ block?: boolean; reason?: string } | void> {
    const run = this.activeRun;
    if (!run) return;
    let currentInput = snapshotEvent(event.input) as Readonly<Record<string, unknown>>;
    for (const invocation of run.invocations) {
      const hook = invocation.mechanism.beforeToolCall;
      if (invocation.initializationFailure || !hook) continue;
      const eventView = Object.freeze({
        type: "tool_call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: currentInput,
        agentRunId: run.agentRunId,
      }) as MechanismToolCallEvent;
      let decision: ToolCallDecision | void;
      try {
        decision = await hook(Object.freeze({
          ...invocation.context,
          agentRunId: run.agentRunId,
          event: eventView,
        }));
      } catch (error) {
        const failure = this.recordHookFailure(invocation, "beforeToolCall", error);
        if (failure.policy !== "continue") return { block: true, reason: failure.reason };
        continue;
      }
      if (!decision || decision.action === "allow") {
        this.recordDecision(invocation, event, run.agentRunId, "tool-allow");
        continue;
      }
      if (decision.action === "deny") {
        const reason = decision.reason.trim() || `mechanism ${invocation.mechanism.name} 阻止了工具调用`;
        this.recordDecision(invocation, event, run.agentRunId, "tool-deny", reason);
        return { block: true, reason };
      }
      if (event.toolName === "__graph_complete__") {
        const reason = "__graph_complete__ 使用固定 ABI，不允许一般 mechanism patch";
        this.recordDecision(invocation, event, run.agentRunId, "tool-deny", reason);
        return { block: true, reason };
      }
      const patched = snapshotEvent(decision.input) as Readonly<Record<string, unknown>>;
      const validationError = this.validateToolInput(event.toolName, patched);
      if (validationError) {
        const reason = `工具参数 patch 被拒绝: ${validationError}`;
        this.recordDecision(invocation, event, run.agentRunId, "tool-deny", reason);
        return { block: true, reason };
      }
      currentInput = patched;
      this.recordDecision(invocation, event, run.agentRunId, "tool-patch");
    }
    if (currentInput !== event.input) {
      const mutableInput = event.input as Record<string, unknown>;
      for (const key of Object.keys(mutableInput)) delete mutableInput[key];
      Object.assign(mutableInput, currentInput);
    }
  }

  private async handleToolResult(event: ToolResultEvent): Promise<{ content?: any[]; isError?: boolean } | void> {
    const run = this.activeRun;
    let content = event.content;
    let isError = event.isError;
    if (run) {
      for (const invocation of run.invocations) {
        const hook = invocation.mechanism.afterToolResult;
        if (invocation.initializationFailure || !hook) continue;
        const view = this.createToolResultView(event, run.agentRunId, content, isError);
        let decision: ToolResultDecision | void;
        try {
          decision = await hook(Object.freeze({
            ...invocation.context,
            agentRunId: run.agentRunId,
            event: view,
          }));
        } catch (error) {
          const failure = this.recordHookFailure(invocation, "afterToolResult", error);
          if (failure.policy !== "continue") {
            content = [{ type: "text", text: failure.reason }];
            isError = true;
          }
          continue;
        }
        if (!decision || decision.action === "keep") {
          this.recordDecision(invocation, event, run.agentRunId, "tool-result-keep");
          continue;
        }
        if (decision.content) content = [...decision.content];
        if (decision.isError !== undefined) isError = decision.isError;
        this.recordDecision(invocation, event, run.agentRunId, "tool-result-replace");
      }
    }
    const agentRunId = run?.agentRunId ?? null;
    const finalView = this.createToolResultView(event, agentRunId, content, isError);
    await this.dispatch("tool_result", finalView);
    if (run) await this.invokeObservationHook("onToolResult", "onToolResult", finalView);
    if (content !== event.content || isError !== event.isError) return { content, isError };
  }

  private createToolResultView(
    event: ToolResultEvent,
    agentRunId: number | null,
    content: ToolResultEvent["content"],
    isError: boolean,
  ): MechanismToolResultEvent {
    const budgeted = snapshotWithBudget({ ...event, content, isError }, this.options.eventMaxBytes);
    return Object.freeze({
      ...(budgeted.value as object),
      agentRunId,
      truncated: budgeted.truncated,
    }) as MechanismToolResultEvent;
  }

  private async invokeObservationHook(
    hookName: "onTurnStart" | "onTurnEnd" | "onToolStart" | "onToolResult",
    phase: MechanismFailurePhase,
    event: unknown,
  ): Promise<void> {
    const run = this.activeRun;
    if (!run) return;
    for (const invocation of run.invocations) {
      const hook = invocation.mechanism[hookName] as ((ctx: any) => void | Promise<void>) | undefined;
      if (invocation.initializationFailure || !hook) continue;
      try {
        await hook(Object.freeze({
          ...invocation.context,
          agentRunId: run.agentRunId,
          event,
        }));
      } catch (error) {
        this.recordHookFailure(invocation, phase, error);
      }
    }
  }

  private validateToolInput(toolName: string, input: Readonly<Record<string, unknown>>): string | null {
    const tool = this.pi.getAllTools().find((candidate) => candidate.name === toolName);
    if (!tool?.parameters) return `工具 ${toolName} 没有可用 schema`;
    try {
      const validator = Schema.Compile(tool.parameters as any);
      const [isValid, errors] = validator.Errors(input);
      if (isValid) return null;
      return errors.slice(0, 3).map((item) => `${item.instancePath || "$"} ${item.message}`).join("; ");
    } catch (error) {
      return `工具 ${toolName} schema 无法安全编译: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private recordHookFailure(
    invocation: MechanismHookInvocation,
    phase: MechanismFailurePhase,
    error: unknown,
  ): MechanismFailureRecord {
    const message = error instanceof Error ? error.message : String(error);
    const failure: MechanismFailureRecord = {
      mechanismName: invocation.mechanism.name,
      phase,
      policy: invocation.mechanism.failurePolicy ?? "continue",
      error,
      reason: `mechanism "${invocation.mechanism.name}" ${phase} 失败: ${message}`,
      scopeId: invocation.context.scope.scopeId,
    };
    this.reportFailure(failure);
    if (failure.policy !== "continue" && invocation.context.scope.isActive()) {
      this.pendingFailures.push(failure);
    }
    return failure;
  }

  private recordCompletionDecisionFailure(
    invocation: MechanismHookInvocation,
    decision: Extract<CompletionDecision, { action: "fail-node" | "fail-graph" }>,
  ): MechanismFailureRecord {
    const policy = decision.action;
    const failure: MechanismFailureRecord = {
      mechanismName: invocation.mechanism.name,
      phase: "validateCompletion",
      policy,
      error: new Error(decision.reason),
      reason: `mechanism "${invocation.mechanism.name}" completion gate ${decision.action}: ${decision.reason}`,
      scopeId: invocation.context.scope.scopeId,
    };
    this.reportFailure(failure);
    if (invocation.context.scope.isActive()) this.pendingFailures.push(failure);
    return failure;
  }

  private recordDecision(
    invocation: MechanismHookInvocation,
    event: Pick<ToolCallEvent, "toolName" | "toolCallId">,
    agentRunId: number,
    decision: MechanismDecisionTraceEntry["decision"],
    reason?: string,
  ): void {
    const list = this.decisionTraces.get(invocation.context.scope.scopeId);
    if (!list) return;
    list.push(Object.freeze({
      timestamp: Date.now(),
      agentRunId,
      mechanismName: invocation.mechanism.name,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      decision,
      ...(reason === undefined ? {} : { reason }),
    }));
  }

  private subscribe<K extends SupportedEventName>(
    eventName: K,
    mechanismName: string,
    policy: MechanismFailurePolicy,
    scope: MechanismScope,
    handler: (event: SupportedEventMap[K]) => void | Promise<void>,
  ): MechanismEventSubscription {
    const subscriber: EventSubscriber = {
      eventName,
      mechanismName,
      policy,
      scope,
      handler: (event) => handler(event as SupportedEventMap[K]),
      disposed: false,
    };
    this.subscribers.get(eventName)!.push(subscriber);
    const subscription = new BrokerSubscription(
      subscriber,
      (item) => this.removeSubscriber(item),
    );
    scope.onCleanup(() => subscription.dispose());
    return subscription;
  }

  private removeSubscriber(subscriber: EventSubscriber): void {
    const list = this.subscribers.get(subscriber.eventName)!;
    const index = list.indexOf(subscriber);
    if (index >= 0) list.splice(index, 1);
  }

  private async dispatch<K extends SupportedEventName>(
    eventName: K,
    event: SupportedEventMap[K],
  ): Promise<void> {
    const snapshot = [...this.subscribers.get(eventName)!];
    for (const subscriber of snapshot) {
      if (subscriber.disposed || !subscriber.scope.isActive()) continue;
      try {
        await subscriber.handler(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure: MechanismFailureRecord = {
          mechanismName: subscriber.mechanismName,
          phase: eventName,
          policy: subscriber.policy,
          error,
          reason: `mechanism "${subscriber.mechanismName}" ${eventName} handler 失败: ${message}`,
          scopeId: subscriber.scope.scopeId,
        };
        this.reportFailure(failure);
        if (subscriber.policy !== "continue" && subscriber.scope.isActive()) {
          this.pendingFailures.push(failure);
        }
      }
    }
  }
}

function snapshotEvent<T>(value: T): T {
  return snapshotValue(value, new WeakMap<object, unknown>()) as T;
}

function snapshotValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
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
    for (const [key, item] of value) {
      copy.set(snapshotValue(key, seen), snapshotValue(item, seen));
    }
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
  for (const key of Object.keys(value)) {
    copy[key] = snapshotValue((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(copy);
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function snapshotWithBudget(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  let remaining = maxBytes;
  let truncated = false;
  const visit = (item: unknown, seen: WeakMap<object, unknown>): unknown => {
    if (typeof item === "string") {
      const result = truncateUtf8(item, Math.max(0, remaining));
      remaining -= Buffer.byteLength(result.value, "utf8");
      if (result.truncated) truncated = true;
      return result.value;
    }
    if (item === null || typeof item !== "object") return item;
    const cached = seen.get(item);
    if (cached) return cached;
    if (Array.isArray(item)) {
      const copy: unknown[] = [];
      seen.set(item, copy);
      for (const child of item) copy.push(visit(child, seen));
      return Object.freeze(copy);
    }
    const copy: Record<string, unknown> = {};
    seen.set(item, copy);
    for (const key of Object.keys(item)) copy[key] = visit((item as Record<string, unknown>)[key], seen);
    return Object.freeze(copy);
  };
  return { value: visit(value, new WeakMap()), truncated };
}

async function withTimeoutAndSignal<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  if (signal.aborted) throw new Error("mechanism scope 已取消");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    abortHandler = () => reject(new Error("mechanism scope 已取消"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}
