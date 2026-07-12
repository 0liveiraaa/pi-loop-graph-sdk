import type { MechanismScope } from "../type.js";
import type { NodeScopeDescriptor } from "../runtime.js";

export interface MechanismCleanupError {
  mechanismName: string;
  error: unknown;
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
