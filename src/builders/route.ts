import type { JsonValue } from "../core/json.js";
import type { Connection, Entry, Route, Transition } from "../core/graph.js";

export interface ConnectionDraft<
  TCompletion extends JsonValue = JsonValue,
  TFrame extends JsonValue = JsonValue,
  TInput extends JsonValue = JsonValue,
> {
  readonly to: Connection["to"];
  readonly transition: Transition<TCompletion, TFrame, TInput>;
}

export function entry<TInput = JsonValue>(id: string, config: Omit<Entry<TInput>, "id">): Entry<TInput> {
  return Object.freeze({ id, ...config });
}
export function defineTransition<TCompletion extends JsonValue = JsonValue, TFrame extends JsonValue = JsonValue, TInput extends JsonValue = JsonValue>(transition: Transition<TCompletion, TFrame, TInput>): Transition<TCompletion, TFrame, TInput> {
  return Object.freeze({ ...transition });
}
export function connect<TCompletion extends JsonValue = JsonValue, TFrame extends JsonValue = JsonValue, TInput extends JsonValue = JsonValue>(to: string, transition: Transition<TCompletion, TFrame, TInput> = {}): ConnectionDraft<TCompletion, TFrame, TInput> {
  return Object.freeze({ to, transition });
}
export function finish<TCompletion extends JsonValue = JsonValue, TFrame extends JsonValue = JsonValue>(transition: Transition<TCompletion, TFrame, never> = {}): ConnectionDraft<TCompletion, TFrame, never> {
  return Object.freeze({ to: "__graph_finish__", transition });
}
export function firstMatch(connections: Readonly<Record<string, ConnectionDraft<any, any, any>>>): Route {
  return Object.freeze({
    kind: "first-match",
    connections: Object.freeze(Object.entries(connections).map(([id, connection]) => Object.freeze({ id, ...connection }))),
  });
}
