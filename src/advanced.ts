/** Advanced, opt-in runtime and extension points. */
export { GraphRuntime } from "./runtime/graph-runtime.js";
export type { GraphRuntimeHost, AgentExecutionContext, InvocationBoundary, InvocationOutcome } from "./runtime/graph-runtime.js";
export { ContextState, materializeProjection } from "./core/context.js";
export type { ContextProjection } from "./core/graph.js";
export type { ContextContribution, ContextSnapshot, ContextStateOptions, ContextContributionHandle, ContextLayer } from "./core/context.js";
export { validateGraph, assertValidGraph, validateGraphTools } from "./validate.js";
export type { GraphValidationIssue, GraphValidationOptions } from "./validate.js";
export { selectEdge } from "./router.js";
export type { ToolResolver, ToolResolverInput } from "./tools-resolve.js";
export { defaultToolResolver, resolveNodeTools, FRAMEWORK_TOOLS } from "./tools-resolve.js";
export type { UnsafeToolResolver, UnsafeToolResolverInput } from "./host/tool-catalog.js";
export { resolveHostBaseline } from "./host/baseline.js";
export type { HostBaseline } from "./host/baseline.js";
export type { GraphExecutionHost, IsolatedGraphSession, IsolatedSessionGraphHostOptions } from "./adapter/graph-execution-host.js";
export { IsolatedSessionGraphHost } from "./adapter/graph-execution-host.js";
