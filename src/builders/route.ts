import type { JsonValue } from "../core/json.js";
import type { Connection, Entry, Route, Transition } from "../core/graph.js";

export interface ConnectionDraft {
  readonly to: Connection["to"];
  readonly transition: Transition;
}

export function entry<TInput = JsonValue>(id: string, config: Omit<Entry<TInput>, "id">): Entry<TInput> {
  return Object.freeze({ id, ...config });
}
export function defineTransition<TCompletion = JsonValue, TFrame = JsonValue, TInput = JsonValue>(transition: Transition<TCompletion, TFrame, TInput>): Transition<TCompletion, TFrame, TInput> {
  return Object.freeze({ ...transition });
}
export function connect(to: string, transition: Transition<any, any, any> = {}): ConnectionDraft {
  return Object.freeze({ to, transition });
}
export function finish(transition: Transition<any, any, any> = {}): ConnectionDraft {
  return Object.freeze({ to: "__graph_finish__", transition });
}
export function firstMatch(connections: Readonly<Record<string, ConnectionDraft>>): Route {
  return Object.freeze({
    kind: "first-match",
    connections: Object.freeze(Object.entries(connections).map(([id, connection]) => Object.freeze({ id, ...connection }))),
  });
}
