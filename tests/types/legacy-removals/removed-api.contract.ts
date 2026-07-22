import type {
  AgentRunRequest,
  Graph,
  LoopGraphExtensionOptions,
  MechanismContext,
  Node,
  NodeContext,
} from "pi-loop-graph-sdk";

// @ts-expect-error Phase 11 removes the global Registry compatibility export.
import { registerGraph } from "pi-loop-graph-sdk";
// @ts-expect-error Phase 11 removes the global Registry compatibility export.
import { initRegistry } from "pi-loop-graph-sdk";
// @ts-expect-error Phase 11 removes the global Registry compatibility export.
import { findEntry } from "pi-loop-graph-sdk";

declare const graph: Graph;
declare const node: Node;
declare const extensionOptions: LoopGraphExtensionOptions;
declare const agentRun: AgentRunRequest;
declare const mechanism: MechanismContext;
declare const nodeContext: NodeContext;

// @ts-expect-error Phase 1 removes Graph.routing.
void graph.routing;
// @ts-expect-error Phase 1 removes the required Node id.
void node.id;
// @ts-expect-error Phase 3 removes defaultTools.
void extensionOptions.defaultTools;
// @ts-expect-error Phase 3 removes AgentRunRequest.tools.
void agentRun.tools;
// @ts-expect-error Phase 5 removes appendContext.
void mechanism.appendContext;
// @ts-expect-error Phase 7 removes NodeContext.callTool.
void nodeContext.callTool;

void registerGraph;
void initRegistry;
void findEntry;
