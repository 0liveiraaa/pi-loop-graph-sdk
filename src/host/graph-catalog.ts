import type { Graph, GraphRef } from "../core/graph.js";

export class GraphCatalog {
  private readonly graphs = new Map<string, Graph>();

  register(graph: Graph): void {
    const key = graphKey(graph);
    if (this.graphs.has(key)) throw new Error(`Graph already registered: ${key}`);
    this.graphs.set(key, graph);
  }

  resolve(ref: GraphRef): Graph | undefined {
    return this.graphs.get(refKey(ref));
  }

  has(ref: GraphRef): boolean {
    return this.graphs.has(refKey(ref));
  }

  get values(): readonly Graph[] {
    return Object.freeze([...this.graphs.values()]);
  }
}

function graphKey(graph: Graph): string {
  return `${graph.id}@${graph.version}`;
}

function refKey(ref: GraphRef): string {
  return `${ref.id}@${ref.version}`;
}
