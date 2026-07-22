import type { TSchema, Static } from "typebox";
import type { JsonSchema, JsonValue } from "./json.js";
import type { ResolvedSkillView, SkillRef } from "./skill.js";
import type { Mechanism } from "./mechanism.js";

export type Awaitable<T> = T | Promise<T>;
export type SchemaValue<S extends TSchema> = Static<S>;

export interface GraphRef {
  readonly id: string;
  readonly version: string;
}

export interface NodeIdentity {
  readonly name: string;
  readonly version?: string;
}

export interface ContextBlockText {
  readonly type: "text";
  readonly text: string;
}
export interface ContextBlockImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}
export type ContextBlock = ContextBlockText | ContextBlockImage;
export type ContextContent = string | readonly ContextBlock[];

export type ContextSelector<TSource, TSelected extends JsonValue> =
  | "all"
  | "none"
  | ((source: Readonly<TSource>) => Awaitable<TSelected | null>);

export interface ContextRenderInput<TSelected extends JsonValue, TMeta> {
  readonly selected: Readonly<TSelected> | null;
  readonly meta: Readonly<TMeta>;
}
export type ContextRenderer<TSelected extends JsonValue, TMeta> = (
  input: ContextRenderInput<TSelected, TMeta>,
) => Awaitable<ContextContent | readonly ContextContent[] | null>;
export interface ContextProjection<TSource, TSelected extends JsonValue, TMeta> {
  readonly select: ContextSelector<TSource, TSelected>;
  readonly render?: ContextRenderer<TSelected, TMeta>;
}

export interface GraphContextMeta {
  readonly graph: { readonly id: string; readonly version: string; readonly goal: string };
  readonly skills: readonly ResolvedSkillView[];
}
export interface GraphMemoryMeta {
  readonly graph: { readonly id: string; readonly version: string };
  readonly revision: number;
}
export interface NodeContextMeta {
  readonly node: { readonly kind: "agent" | "code" | "graph"; readonly subGoal: string; readonly identity?: NodeIdentity };
  readonly skills: readonly ResolvedSkillView[];
  readonly connections: readonly unknown[];
}

export interface GraphContextDefinition<TInput, TBackground extends JsonValue, TMemory extends JsonValue> {
  readonly background: ContextProjection<TInput, TBackground, GraphContextMeta>;
  readonly memory?: ContextProjection<readonly JsonValue[], TMemory, GraphMemoryMeta>;
}
export interface NodeContextDefinition<TInput> {
  readonly focus: ContextProjection<TInput, JsonValue, NodeContextMeta>;
}

export interface NodeCompletion<TResult = JsonValue> {
  readonly result: TResult;
}
export interface CodeNodeExecution<TInput, TResult> {
  readonly input: Readonly<TInput>;
  readonly complete: (result: TResult) => TResult;
  readonly runAgent: (request: AgentRunRequest) => Promise<NodeCompletion>;
  /** Present during resume; use for idempotent-side-effect guards. */
  readonly resumeAttempt?: number;
  readonly nodeVisitId?: string;
  readonly rootRunId?: string;
}

export interface AgentRunRequest {
  readonly prompt: string;
  readonly output?: JsonSchema;
}

export interface AgentNodeDefinition<TInputSchema extends TSchema = TSchema, TResultSchema extends TSchema = TSchema> {
  readonly kind: "agent";
  readonly subGoal: string;
  readonly input: JsonSchema<TInputSchema>;
  readonly output: JsonSchema<TResultSchema>;
  readonly identity?: NodeIdentity;
  readonly context?: NodeContextDefinition<SchemaValue<TInputSchema>>;
  readonly tools?: readonly string[] | "all";
  readonly skills?: readonly SkillRef[];
  readonly prompt?: string;
  readonly mechanisms?: readonly Mechanism[];
}

export interface CodeNodeDefinition<TInputSchema extends TSchema = TSchema, TResultSchema extends TSchema = TSchema> {
  readonly kind: "code";
  readonly subGoal: string;
  readonly input: JsonSchema<TInputSchema>;
  readonly output: JsonSchema<TResultSchema>;
  readonly identity?: NodeIdentity;
  readonly context?: NodeContextDefinition<SchemaValue<TInputSchema>>;
  readonly tools?: readonly string[] | "all";
  readonly skills?: readonly SkillRef[];
  readonly execute: (execution: CodeNodeExecution<SchemaValue<TInputSchema>, SchemaValue<TResultSchema>>) => Awaitable<SchemaValue<TResultSchema>>;
  readonly mechanisms?: readonly Mechanism[];
}

export interface GraphNodeDefinition<TInputSchema extends TSchema = TSchema, TResultSchema extends TSchema = TSchema> {
  readonly kind: "graph";
  readonly subGoal: string;
  readonly input: JsonSchema<TInputSchema>;
  readonly output: JsonSchema<TResultSchema>;
  readonly identity?: NodeIdentity;
  readonly graph: GraphRef;
  readonly boundary: "call" | "compose" | "delegate";
  readonly skills?: readonly SkillRef[];
  readonly mechanisms?: readonly Mechanism[];
}

export type NodeDefinition = AgentNodeDefinition | CodeNodeDefinition | GraphNodeDefinition;
export interface Entry<TInput = JsonValue> {
  readonly id: string;
  readonly to: string;
  readonly guard?: (input: Readonly<TInput>) => Awaitable<boolean>;
  readonly mapInput?: (input: Readonly<TInput>) => JsonValue;
}

export interface Transition<TCompletion = JsonValue, TFrame = JsonValue, TInput = JsonValue> {
  readonly guard?: (input: Readonly<TCompletion>) => Awaitable<boolean>;
  readonly frame?: (input: { readonly completion: Readonly<NodeCompletion<TCompletion>> }) => TFrame;
  readonly map?: (input: { readonly completion: Readonly<NodeCompletion<TCompletion>> }) => TInput;
  readonly output?: (input: { readonly completion: Readonly<NodeCompletion<TCompletion>> }) => JsonValue;
}
export interface Connection {
  readonly id: string;
  readonly to: string | "__graph_finish__";
  readonly transition: Transition;
}
export interface Route {
  readonly kind: "first-match" | "priority-first" | "agent-choice" | "custom";
  readonly connections: readonly Connection[];
}
export interface Stage {
  readonly node: NodeDefinition;
  readonly route: Route;
}
export type GraphToolPolicy = readonly string[];
export interface GraphDefinition<TInputSchema extends TSchema = TSchema, TOutputSchema extends TSchema = TSchema> {
  readonly id: string;
  readonly version: string;
  readonly goal: string;
  readonly input: JsonSchema<TInputSchema>;
  readonly output: JsonSchema<TOutputSchema>;
  readonly context: GraphContextDefinition<SchemaValue<TInputSchema>, JsonValue, JsonValue>;
  readonly entries: readonly Entry<SchemaValue<TInputSchema>>[];
  readonly stages: Readonly<Record<string, Stage>>;
  readonly tools?: GraphToolPolicy;
  readonly skills?: readonly SkillRef[];
  readonly mechanisms?: readonly Mechanism[];
}
export type Graph<TInputSchema extends TSchema = TSchema, TOutputSchema extends TSchema = TSchema> = GraphDefinition<TInputSchema, TOutputSchema>;

export function graphRef(id: string, version: string): GraphRef {
  if (!id || !version) throw new Error("GraphRef requires id and version");
  return Object.freeze({ id, version });
}

export function defineGraph<TInputSchema extends TSchema, TOutputSchema extends TSchema>(
  graph: GraphDefinition<TInputSchema, TOutputSchema>,
): Graph<TInputSchema, TOutputSchema> {
  validateGraphDefinition(graph);
  const stages = Object.fromEntries(Object.entries(graph.stages).map(([id, stage]) => [
    id,
    Object.freeze({
      ...stage,
      route: Object.freeze({
        ...stage.route,
        connections: Object.freeze(stage.route.connections.map((connection) => Object.freeze({
          ...connection,
          transition: Object.freeze({ ...connection.transition }),
        }))),
      }),
    }),
  ]));
  return Object.freeze({
    ...graph,
    stages: Object.freeze(stages),
    entries: Object.freeze(graph.entries.map((item) => Object.freeze({ ...item }))),
  });
}

export function validateGraphDefinition(graph: GraphDefinition): void {
  if (!graph.id || !graph.version || !graph.goal) throw new Error("Graph requires id, version, and goal");
  if (!graph.entries.length) throw new Error("Graph requires at least one entry");
  const entryIds = new Set<string>();
  for (const entry of graph.entries) {
    if (entryIds.has(entry.id)) throw new Error(`Duplicate Entry ID: ${entry.id}`);
    entryIds.add(entry.id);
  }
  for (const [stageId, stage] of Object.entries(graph.stages)) {
    if (!stageId) throw new Error("Stage ID cannot be empty");
    const connectionIds = new Set<string>();
    for (const connection of stage.route.connections) {
      if (connectionIds.has(connection.id)) throw new Error(`Duplicate Connection ID in Stage "${stageId}": ${connection.id}`);
      connectionIds.add(connection.id);
      if (connection.to !== "__graph_finish__" && !(connection.to in graph.stages)) {
        throw new Error(`Connection "${connection.id}" targets missing Stage "${connection.to}"`);
      }
      if (connection.to === "__graph_finish__" && !connection.transition.output) {
        throw new Error(`Finish Connection "${connection.id}" requires an explicit output mapper`);
      }
    }
  }
  for (const entry of graph.entries) if (!(entry.to in graph.stages)) throw new Error(`Entry "${entry.id}" targets missing Stage "${entry.to}"`);
}
