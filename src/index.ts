// Loop Graph SDK — public library API
//
//  作为 library 使用（推荐）：
//    import { createLoopGraphExtension, Graph, ... } from "pi-loop-graph-sdk";
//
//  作为 debug/demo extension 使用：
//    pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
//    （自动加载 ./extension → 注册测试图）

// ── 实例运行时工厂（新 API，推荐）──
export {
  createLoopGraphExtension,
  defaultCompletionFeedbackFormatter,
} from "./adapter/loop-graph-extension.js";
export type {
  LoopGraphExtension,
  LoopGraphExtensionOptions,
  LoopGraphLimits,
  CompletionFeedbackFormatter,
  CompletionFeedbackInput,
  ContextRendererRegistry,
  LoopGraphExecutionOptions,
} from "./adapter/loop-graph-extension.js";
export {
  DEFAULT_OUTPUT_CONTRACT_MAX_BYTES,
  OUTPUT_CONTRACT_MESSAGE_TYPE,
  prepareOutputContract,
} from "./adapter/output-contract.js";
export type { PreparedOutputContract } from "./adapter/output-contract.js";
export type {
  DeadRunMessageInput,
  GraphFailureMessageInput,
  IncompleteNodeMessageInput,
  ModelMessageFormatter,
} from "./adapter/model-messages.js";
export {
  defaultSkillContentProvider,
  defaultSkillContentRenderer,
} from "./adapter/skill-content.js";
export type {
  SkillContentProvider,
  SkillContentRenderer,
  SkillFailurePolicies,
  SkillFailurePolicy,
  SkillLoadContext,
} from "./adapter/skill-content.js";

// ── 图注册表（新 API）──
export { GraphRegistry, encodeGraphToolResult, limitGraphToolResultText } from "./registry.js";
export type { ExecuteGraph, GraphToolResultFormatter } from "./registry.js";

// ── 工具解析 ──
export { resolveNodeTools, defaultToolResolver, FRAMEWORK_TOOLS } from "./tools-resolve.js";
export type { ToolResolver, ToolResolverInput } from "./tools-resolve.js";

// ── 可观测性 ──
export { createJsonlTraceSink } from "./adapter/observability.js";
export type {
  AgentRunLifecycleContext,
  LoopGraphLifecycleEvent,
  LoopGraphLogger,
  LoopGraphTraceSink,
} from "./adapter/observability.js";

// ── execute 工厂 ──
export { createAgentExecute } from "./agent-execute.js";
export type { AgentExecuteOptions } from "./agent-execute.js";

// ── 隔离图执行载体 ──
export { IsolatedSessionGraphHost } from "./adapter/graph-execution-host.js";
export { createIsolatedGraphSessionFactory } from "./adapter/isolated-graph-session.js";
export type {
  GraphExecutionHost,
  IsolatedGraphSession,
  IsolatedGraphSessionFactory,
  IsolatedSessionGraphHostOptions,
} from "./adapter/graph-execution-host.js";
export type { IsolatedGraphSessionFactoryOptions } from "./adapter/isolated-graph-session.js";

// ── 核心类型 ──
export * from "./type.js";
export { Type } from "typebox";
export type {
  AgentNodeDefinition,
  AgentRunRequest,
  CodeNodeDefinition,
  Connection,
  ContextContent,
  ContextProjection,
  Entry as CoreEntry,
  Graph,
  GraphDefinition,
  GraphNodeDefinition,
  GraphRef,
  NodeDefinition,
  NodeDefinition as Node,
  Route,
  Stage,
  Transition,
} from "./core/graph.js";
export type { JsonValue, JsonSchema } from "./core/json.js";
export type { ResolvedSkillView, SkillRef } from "./core/skill.js";
export { ContextState, materializeProjection } from "./core/context.js";
export type {
  ContextContribution,
  ContextLayer,
  ContextLifetime,
  ContextRetention,
  ContextSnapshot,
  ContextStateOptions,
  NodeContextMaterialization,
  ContextContributionHandle,
} from "./core/context.js";
export { defineMechanism } from "./core/mechanism.js";
export type {
  Mechanism,
  MechanismContext,
  MechanismContextApi,
  MechanismDecisionTrace,
  MechanismExec,
  MechanismExecResult,
  MechanismFailurePolicy,
  MechanismInstallation,
  MechanismScope,
  MechanismCompletionDecision,
} from "./core/mechanism.js";
export { MechanismRuntime } from "./runtime/mechanism-runtime.js";
export type {
  MechanismRuntimeOptions,
  MechanismFailureRecord,
  MechanismChain,
} from "./runtime/mechanism-runtime.js";
export type { ToolSet } from "./builders/refs.js";
export { GraphCatalog } from "./host/graph-catalog.js";
export { SkillCatalog } from "./host/skill-catalog.js";
export type {
  SkillCatalogOptions,
  SkillRegistration,
  SkillResolver,
  SkillResolverFunction,
} from "./host/skill-catalog.js";
export {
  RUNTIME_PROTOCOL_TOOL_NAME,
  ToolCatalog,
} from "./host/tool-catalog.js";
export type {
  ToolImplementation,
  UnsafeToolResolver,
  UnsafeToolResolverInput,
} from "./host/tool-catalog.js";
export {
  DEFAULT_HOST_BASELINE,
  resolveHostBaseline,
} from "./host/baseline.js";
export type { HostBaseline } from "./host/baseline.js";
export {
  DEFAULT_INVOCATION_LIMITS,
  resolveInvocationLimits,
} from "./core/limits.js";
export type { InvocationLimits } from "./core/limits.js";
export type {
  GraphFailure,
  GraphFailureCode,
  GraphRunResult,
} from "./core/result.js";
export { defineGraph, defineLinearGraph, defineSingleAgentGraph } from "./builders/graph.js";
export { agentNode, codeNode, graphNode } from "./builders/node.js";
export { connect, defineTransition, entry, finish, firstMatch } from "./builders/route.js";
export { graphRef } from "./core/graph.js";
export { skillRef, toolSet } from "./builders/refs.js";

// ── 运行时与路由 ──
export { GraphRuntime } from "./runtime/graph-runtime.js";
export type {
  GraphRuntimeHost,
} from "./runtime/graph-runtime.js";
export type { CallFrame } from "./runtime.js";
export { validateGraph, assertValidGraph, validateGraphTools } from "./validate.js";
export type { GraphValidationIssue, GraphValidationOptions } from "./validate.js";
export { selectEdge } from "./router.js";

// ── 消息投影（高级）──
export {
  projectMessages,
  defaultFrameFormatter,
  defaultNodeContextRenderer,
  stripClosedGraphCalls,
} from "./adapter/projection.js";
export type {
  ProjectionInput,
  MessageEntry,
  EdgeChoice,
  GraphContextView,
  NodeContextView,
  NodeInputView,
  NodeContextRenderInput,
  NodeContextRenderer,
  RenderedContextContentBlock,
  RenderedContextMessage,
  RenderedNodeContext,
} from "./adapter/projection.js";

// ── @deprecated 全局兼容层（向后兼容旧代码）──
export {
  registerGraph,
  initRegistry,
  findEntry,
} from "./registry.js";
