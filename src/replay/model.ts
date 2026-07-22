import type { ReplayDocument } from "./finalizer.js";
import type { ReplayEventEnvelope } from "./events.js";

export interface ReplayInvocationModel {
  readonly id: string;
  readonly parentId?: string;
  readonly graphId?: string;
  readonly graphVersion?: string;
  readonly boundary?: string;
  readonly events: readonly ReplayEventEnvelope[];
  readonly children: readonly ReplayInvocationModel[];
}

export interface ReplayModel {
  readonly schemaVersion: 1;
  readonly rootRunId: string;
  readonly mode: ReplayDocument["mode"];
  readonly createdAt: string;
  readonly recording: ReplayDocument["recording"];
  readonly result: ReplayDocument["result"];
  readonly totalCost?: number;
  readonly summary: Readonly<Record<string, number>>;
  readonly invocations: readonly ReplayInvocationModel[];
  readonly unscopedEvents: readonly ReplayEventEnvelope[];
}
