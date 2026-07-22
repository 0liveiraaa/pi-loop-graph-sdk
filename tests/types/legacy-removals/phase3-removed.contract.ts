import type {
  AgentRunRequest,
  LoopGraphExtensionOptions,
} from "pi-loop-graph-sdk";

declare const request: AgentRunRequest;
declare const options: LoopGraphExtensionOptions;

// @ts-expect-error Phase 3 removes implicit Extension-wide business tools.
void options.defaultTools;
// @ts-expect-error Phase 3 replaces the legacy single base path with a dedicated Skill Catalog/resolver.
void options.skillBasePath;
// @ts-expect-error Phase 3 keeps tool selection on the Node definition.
void request.tools;
