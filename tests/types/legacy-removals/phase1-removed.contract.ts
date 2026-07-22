import type { Graph, Node } from "pi-loop-graph-sdk";

declare const graph: Graph;
declare const node: Node;

// @ts-expect-error Phase 1 removes the parallel Graph.routing topology.
void graph.routing;
// @ts-expect-error Phase 1 makes Stage ID the only graph-local runtime identity.
void node.id;
