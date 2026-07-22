import type { Graph, NodeDefinition } from "../core/graph.js";
import type { TSchema } from "typebox";

export const RUNTIME_PROTOCOL_TOOL_NAME = "__graph_complete__" as const;

export interface ToolImplementation {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly parameters?: TSchema;
  readonly execute?: (...args: readonly unknown[]) => unknown | Promise<unknown>;
  readonly protocol?: boolean;
}

export interface UnsafeToolResolverInput {
  readonly graph: Graph;
  readonly stageId: string;
  readonly node: NodeDefinition;
  readonly selected: readonly string[];
  readonly hostTools: readonly string[];
}

export type UnsafeToolResolver = (
  input: UnsafeToolResolverInput,
) => readonly string[];

export class ToolCatalog {
  private readonly tools = new Map<string, ToolImplementation>();

  register(tool: ToolImplementation): void {
    if (!tool.name || tool.name === RUNTIME_PROTOCOL_TOOL_NAME) {
      throw new Error(`Invalid business tool name: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, Object.freeze({ ...tool }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  resolve(name: string): ToolImplementation | undefined {
    return this.tools.get(name);
  }

  get names(): readonly string[] {
    return Object.freeze([...this.tools.keys()]);
  }
}

export function selectNodeToolNames(graph: Graph, node: NodeDefinition): readonly string[] {
  const policy = graph.tools ?? [];
  const nodeTools = node.kind === "graph" ? undefined : node.tools;
  const selected: readonly string[] = nodeTools === "all" ? policy : (nodeTools ?? []);
  const allowed = new Set(policy);
  for (const name of selected) {
    if (!allowed.has(name)) {
      throw new Error(`Node selects tool outside Graph policy: ${name}`);
    }
  }
  return Object.freeze([...new Set(selected)]);
}
