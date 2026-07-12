import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentInstance,
  Mechanism,
  MechanismEvents,
  MechanismEventSubscription,
  MechanismFailurePolicy,
  MechanismScope,
  MechanismToolResultEvent,
  MechanismTurnEndEvent,
  MechanismTurnStartEvent,
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

  constructor(
    pi: ExtensionAPI,
    private readonly reportFailure: (failure: MechanismFailureRecord) => void,
  ) {
    pi.on("tool_result", async (event) => {
      await this.dispatch("tool_result", snapshotEvent(event) as MechanismToolResultEvent);
    });
    pi.on("turn_start", async (event) => {
      await this.dispatch("turn_start", snapshotEvent(event) as MechanismTurnStartEvent);
    });
    pi.on("turn_end", async (event) => {
      await this.dispatch("turn_end", snapshotEvent(event) as MechanismTurnEndEvent);
    });
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
