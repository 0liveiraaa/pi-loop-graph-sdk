import type {
  ContextBlock,
  ContextContent,
  ContextProjection,
  Graph,
  GraphContextMeta,
  GraphMemoryMeta,
  NodeContextMeta,
  NodeDefinition,
  Stage,
} from "./graph.js";
import type { JsonValue } from "./json.js";
import type { ResolvedSkillView } from "./skill.js";

export type ContextRetention = "sticky" | "foldable" | "transient";
export type ContextLifetime = "agent-run" | "node-visit" | "graph-invocation" | "root-run";

export interface ContextContribution {
  readonly id: string;
  readonly owner: "host" | "graph" | "node" | "agent-run" | "runtime";
  readonly scopeId: string;
  readonly lifetime: ContextLifetime;
  readonly retention: ContextRetention;
  readonly content: ContextContent;
}

export interface ContextContributionHandle {
  readonly id: string;
  update(content: ContextContent): void;
  dispose(): void;
}

export interface ContextLayer {
  readonly name: "host" | "graph" | "memory" | "node" | "mechanism" | "output-contract" | "prompt";
  readonly scopeId: string;
  readonly retention: ContextRetention;
  readonly content: ContextContent;
}

export interface ContextSnapshot {
  readonly rootRunId: string;
  readonly graphInvocationId: string;
  readonly nodeVisitId?: string;
  readonly agentRunId?: string;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly memoryRevision: number;
  readonly layers: readonly ContextLayer[];
  readonly contributions: readonly ContextContribution[];
}

export interface ContextStateOptions {
  readonly rootRunId: string;
  readonly graphInvocationId: string;
  readonly graph: Graph;
  readonly graphInput: JsonValue;
  readonly graphSkills: readonly ResolvedSkillView[];
  readonly frames: readonly JsonValue[];
  readonly hostContent?: ContextContent | null;
  readonly frameRevision?: { value: number };
  readonly externalContributions?: (nodeVisitId?: string) => readonly ContextContribution[];
}

export interface NodeContextMaterialization {
  readonly nodeVisitId: string;
  readonly stageId: string;
  readonly snapshot: ContextSnapshot;
}

/** Canonical, scope-owned context state for one Graph Invocation. */
export class ContextState {
  private graphLayers: readonly ContextLayer[] = Object.freeze([]);
  private readonly contributions = new Map<string, ContextContribution>();
  private readonly frameRevision: { value: number };
  private memoryCache: { revision: number; content: ContextContent | null } | null = null;

  constructor(private readonly options: ContextStateOptions) {
    this.frameRevision = options.frameRevision ?? { value: 0 };
  }

  async initialize(): Promise<void> {
    const { graph, graphInput, graphSkills } = this.options;
    const background = await materializeProjection<JsonValue, JsonValue, GraphContextMeta>(
      graph.context.background as ContextProjection<JsonValue, JsonValue, GraphContextMeta>,
      graphInput,
      {
        graph: { id: graph.id, version: graph.version, goal: graph.goal },
        skills: graphSkills,
      },
      defaultGraphRenderer,
    );
    this.graphLayers = Object.freeze([
      ...(this.options.hostContent == null ? [] : [{
        name: "host" as const,
        scopeId: this.options.rootRunId,
        retention: "sticky" as const,
        content: this.options.hostContent,
      }]),
      ...(background == null ? [] : [{
        name: "graph" as const,
        scopeId: this.options.graphInvocationId,
        retention: "sticky" as const,
        content: background,
      }]),
    ]);
  }

  bumpMemoryRevision(): void {
    this.frameRevision.value += 1;
  }

  async materializeNode(
    nodeVisitId: string,
    stageId: string,
    stage: Stage,
    nodeInput: JsonValue,
    nodeSkills: readonly ResolvedSkillView[],
  ): Promise<NodeContextMaterialization> {
    const memory = await this.materializeMemory();
    const nodeLayer = stage.node.kind === "graph"
      ? null
      : await materializeNodeLayer(stage.node, stage, nodeInput, nodeSkills, nodeVisitId);
    const layers: ContextLayer[] = [...this.graphLayers];
    if (memory != null) {
      layers.push({
        name: "memory",
        scopeId: this.options.graphInvocationId,
        retention: "sticky",
        content: memory,
      });
    }
    if (nodeLayer) layers.push(nodeLayer);
    return {
      nodeVisitId,
      stageId,
      snapshot: this.snapshot(nodeVisitId, layers),
    };
  }

  snapshot(nodeVisitId?: string, layers: readonly ContextLayer[] = this.graphLayers): ContextSnapshot {
    const contributions = [
      ...(this.options.externalContributions?.(nodeVisitId) ?? []),
      ...this.contributions.values(),
    ];
    const mechanismContent = contributions.flatMap((item) => typeof item.content === "string"
      ? [{ type: "text" as const, text: item.content }]
      : item.content);
    const projectedLayers = mechanismContent.length === 0 ? layers : [...layers, {
      name: "mechanism" as const,
      scopeId: nodeVisitId ?? this.options.graphInvocationId,
      retention: "sticky" as const,
      content: Object.freeze(mechanismContent.map((block) => Object.freeze({ ...block }))),
    }];
    return Object.freeze({
      rootRunId: this.options.rootRunId,
      graphInvocationId: this.options.graphInvocationId,
      nodeVisitId,
      graphId: this.options.graph.id,
      graphVersion: this.options.graph.version,
      memoryRevision: this.frameRevision.value,
      layers: Object.freeze(projectedLayers.map((layer) => Object.freeze({ ...layer }))),
      contributions: Object.freeze(contributions.map((item) => Object.freeze({ ...item }))),
    });
  }

  refreshSnapshot(snapshot: ContextSnapshot, agentRunId?: string): ContextSnapshot {
    return Object.freeze({
      ...this.snapshot(snapshot.nodeVisitId, snapshot.layers.filter((layer) => layer.name !== "mechanism")),
      ...(agentRunId === undefined ? {} : { agentRunId }),
    });
  }

  addContribution(contribution: ContextContribution): ContextContributionHandle {
    if (this.contributions.has(contribution.id)) throw new Error(`Context contribution already exists: ${contribution.id}`);
    this.contributions.set(contribution.id, freezeContribution(contribution));
    let active = true;
    return Object.freeze({
      id: contribution.id,
      update: (content: ContextContent) => {
        if (!active) throw new Error(`Context contribution is disposed: ${contribution.id}`);
        const current = this.contributions.get(contribution.id);
        if (!current) throw new Error(`Context contribution is unavailable: ${contribution.id}`);
        this.contributions.set(contribution.id, freezeContribution({ ...current, content }));
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this.contributions.delete(contribution.id);
      },
    });
  }

  private async materializeMemory(): Promise<ContextContent | null> {
    const projection = this.options.graph.context.memory ?? { select: "all" as const };
    if (this.memoryCache?.revision === this.frameRevision.value) return this.memoryCache.content;
    const content = await materializeProjection<readonly JsonValue[], JsonValue, GraphMemoryMeta>(
      projection,
      this.options.frames,
      {
        graph: { id: this.options.graph.id, version: this.options.graph.version },
        revision: this.frameRevision.value,
      },
      defaultMemoryRenderer,
    );
    this.memoryCache = { revision: this.frameRevision.value, content };
    return content;
  }
}

function freezeContribution(contribution: ContextContribution): ContextContribution {
  const content = normalizeContextContent(contribution.content);
  if (content == null) throw new Error("Context contribution content cannot be empty");
  return Object.freeze({ ...contribution, content });
}

async function materializeNodeLayer(
  node: Exclude<NodeDefinition, { kind: "graph" }>,
  stage: Stage,
  nodeInput: JsonValue,
  skills: readonly ResolvedSkillView[],
  nodeVisitId: string,
): Promise<ContextLayer | null> {
  const projection = node.context?.focus ?? (node.kind === "agent"
    ? { select: "all" as const }
    : { select: "none" as const });
  const content = await materializeProjection<JsonValue, JsonValue, NodeContextMeta>(
    projection as ContextProjection<JsonValue, JsonValue, NodeContextMeta>,
    nodeInput,
    {
      node: {
        kind: node.kind,
        subGoal: node.subGoal,
        identity: node.identity,
      },
      skills,
      connections: stage.route.connections.map((connection) => ({
        id: connection.id,
        to: connection.to,
      })),
    },
    defaultNodeRenderer,
  );
  return content == null ? null : {
    name: "node",
    scopeId: nodeVisitId,
    retention: "sticky",
    content,
  };
}

export async function materializeProjection<TSource, TSelected extends JsonValue, TMeta>(
  projection: ContextProjection<TSource, TSelected, TMeta>,
  source: TSource,
  meta: TMeta,
  fallback: (input: { readonly selected: Readonly<TSelected> | null; readonly meta: Readonly<TMeta> }) => ContextContent | null,
): Promise<ContextContent | null> {
  const selected = projection.select === "all"
    ? source as unknown as TSelected
    : projection.select === "none"
      ? null
      : await projection.select(source as Readonly<TSource>);
  const frozen = selected == null ? null : deepFreeze(cloneJson(selected));
  const rendered = projection.render
    ? await projection.render({ selected: frozen, meta: Object.freeze(meta) })
    : fallback({ selected: frozen, meta: Object.freeze(meta) });
  return normalizeContextContent(rendered);
}

function defaultGraphRenderer(input: { readonly selected: Readonly<JsonValue> | null; readonly meta: Readonly<GraphContextMeta> }): ContextContent {
  const lines = [`=== GRAPH GOAL ===\n${input.meta.graph.goal}`];
  if (input.selected != null) lines.push(`=== BACKGROUND ===\n${JSON.stringify(input.selected)}`);
  for (const skill of input.meta.skills) lines.push(skill.content);
  return lines.join("\n");
}

function defaultMemoryRenderer(input: { readonly selected: Readonly<JsonValue> | null; readonly meta: Readonly<GraphMemoryMeta> }): ContextContent | null {
  return input.selected == null || Array.isArray(input.selected) && input.selected.length === 0
    ? null
    : `=== COMPLETED WORK ===\n${JSON.stringify(input.selected)}`;
}

function defaultNodeRenderer(input: { readonly selected: Readonly<JsonValue> | null; readonly meta: Readonly<NodeContextMeta> }): ContextContent {
  const lines = [
    `=== NODE SUBGOAL ===\n${input.meta.node.subGoal}`,
  ];
  if (input.selected != null) lines.push(`=== NODE FOCUS ===\n${JSON.stringify(input.selected)}`);
  if (input.meta.connections.length) lines.push(`=== CONNECTIONS ===\n${JSON.stringify(input.meta.connections)}`);
  for (const skill of input.meta.skills) lines.push(skill.content);
  return lines.join("\n");
}

function normalizeContextContent(content: ContextContent | readonly ContextContent[] | null | undefined): ContextContent | null {
  if (content == null) return null;
  const values = Array.isArray(content) ? content : [content];
  const blocks: ContextBlock[] = [];
  for (const value of values) {
    if (typeof value === "string") blocks.push({ type: "text", text: value });
    else if (isContextBlock(value)) blocks.push(Object.freeze({ ...value }));
    else throw new Error("Context renderer returned invalid content");
  }
  return Object.freeze(blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks);
}

function isContextBlock(value: unknown): value is ContextBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  return block.type === "text" && typeof block.text === "string"
    || block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
