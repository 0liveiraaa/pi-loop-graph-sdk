import type { TSchema } from "typebox";
import type { AgentNodeDefinition, CodeNodeDefinition, GraphNodeDefinition } from "../core/graph.js";

export function agentNode<TInputSchema extends TSchema, TOutputSchema extends TSchema>(input: Omit<AgentNodeDefinition<TInputSchema, TOutputSchema>, "kind">): AgentNodeDefinition<TInputSchema, TOutputSchema> {
  return Object.freeze({ ...input, kind: "agent" });
}
export function codeNode<TInputSchema extends TSchema, TOutputSchema extends TSchema>(input: Omit<CodeNodeDefinition<TInputSchema, TOutputSchema>, "kind">): CodeNodeDefinition<TInputSchema, TOutputSchema> {
  return Object.freeze({ ...input, kind: "code" });
}
export function graphNode<TInputSchema extends TSchema, TOutputSchema extends TSchema>(input: Omit<GraphNodeDefinition<TInputSchema, TOutputSchema>, "kind" | "boundary"> & { boundary?: GraphNodeDefinition["boundary"] }): GraphNodeDefinition<TInputSchema, TOutputSchema> {
  return Object.freeze({ ...input, kind: "graph", boundary: input.boundary ?? "call" });
}
