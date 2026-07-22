import type { Graph, NodeDefinition } from "../core/graph.js";
import type { SkillRef } from "../core/skill.js";
import type { SkillCatalog } from "./skill-catalog.js";
import {
  RUNTIME_PROTOCOL_TOOL_NAME,
  selectNodeToolNames,
  type ToolCatalog,
  type UnsafeToolResolver,
} from "./tool-catalog.js";

export type CapabilityPreflightCode = "invalid-graph" | "tool-unavailable" | "host-unavailable";

export class CapabilityPreflightError extends Error {
  constructor(
    readonly code: CapabilityPreflightCode,
    readonly phase: "graph" | "host",
    message: string,
    readonly stageId?: string,
  ) {
    super(message);
    this.name = "CapabilityPreflightError";
  }
}

export interface CapabilityPreflightHost {
  readonly toolCatalog?: ToolCatalog;
  readonly skillCatalog?: SkillCatalog;
  readonly unsafeToolResolver?: UnsafeToolResolver;
}

export function preflightGraphCapabilities(
  graph: Graph,
  host: CapabilityPreflightHost,
): void {
  const policy = graph.tools ?? [];
  if (new Set(policy).size !== policy.length) {
    throw new CapabilityPreflightError(
      "invalid-graph",
      "graph",
      `Graph Tool Policy contains duplicate names: ${graph.id}@${graph.version}`,
    );
  }
  if (policy.includes(RUNTIME_PROTOCOL_TOOL_NAME)) {
    throw new CapabilityPreflightError(
      "invalid-graph",
      "graph",
      `Graph Tool Policy cannot declare Runtime protocol tool: ${RUNTIME_PROTOCOL_TOOL_NAME}`,
    );
  }
  if (policy.length > 0 && !host.toolCatalog) {
    throw new CapabilityPreflightError(
      "tool-unavailable",
      "host",
      `Graph requires business tools but Host has no Tool Catalog: ${graph.id}@${graph.version}`,
    );
  }
  for (const name of policy) assertToolAvailable(host.toolCatalog, name);
  assertSkillsAvailable(graph.skills, host.skillCatalog);

  for (const [stageId, stage] of Object.entries(graph.stages)) {
    const selected = resolveNodeToolNames(graph, stageId, stage.node, host);
    for (const name of selected) {
      if (name !== RUNTIME_PROTOCOL_TOOL_NAME) assertToolAvailable(host.toolCatalog, name, stageId);
    }
    assertSkillsAvailable(stage.node.skills, host.skillCatalog, stageId);
  }
}

export function resolveNodeToolNames(
  graph: Graph,
  stageId: string,
  node: NodeDefinition,
  host: Pick<CapabilityPreflightHost, "toolCatalog" | "unsafeToolResolver">,
): readonly string[] {
  const policy = graph.tools ?? [];
  const nodeTools = node.kind === "graph" ? undefined : node.tools;
  const requested = nodeTools === "all" ? policy : (nodeTools ?? []);
  if (!host.unsafeToolResolver) {
    try {
      return selectNodeToolNames(graph, node);
    } catch (error) {
      throw new CapabilityPreflightError(
        "invalid-graph",
        "graph",
        error instanceof Error ? error.message : String(error),
        stageId,
      );
    }
  }
  const names = host.unsafeToolResolver(Object.freeze({
    graph,
    stageId,
    node,
    selected: Object.freeze([...requested]),
    hostTools: host.toolCatalog?.names ?? [],
  }));
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new CapabilityPreflightError(
      "invalid-graph",
      "host",
      "UnsafeToolResolver must return non-empty tool names",
      stageId,
    );
  }
  return Object.freeze([...new Set(names)]);
}

function assertToolAvailable(catalog: ToolCatalog | undefined, name: string, stageId?: string): void {
  if (!catalog?.has(name)) {
    throw new CapabilityPreflightError(
      "tool-unavailable",
      "host",
      `Host tool unavailable: ${name}`,
      stageId,
    );
  }
}

function assertSkillsAvailable(
  refs: readonly SkillRef[] | undefined,
  catalog: SkillCatalog | undefined,
  stageId?: string,
): void {
  for (const ref of refs ?? []) {
    let resolved;
    try {
      resolved = catalog?.resolve(ref);
    } catch (error) {
      if (!ref.required) continue;
      throw new CapabilityPreflightError(
        "host-unavailable",
        "host",
        `Required Skill resolution failed: ${ref.name}${ref.version ? `@${ref.version}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        stageId,
      );
    }
    if (!ref.required || resolved) continue;
    throw new CapabilityPreflightError(
      "host-unavailable",
      "host",
      `Required Skill unavailable: ${ref.name}${ref.version ? `@${ref.version}` : ""}`,
      stageId,
    );
  }
}
