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
  GraphExposure,
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

// ── 可观测性 ──
export { createJsonlTraceSink } from "./adapter/observability.js";
export type {
  AgentRunLifecycleContext,
  LoopGraphLifecycleEvent,
  LoopGraphLogger,
  LoopGraphTraceSink,
} from "./adapter/observability.js";

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
export type { ToolSet } from "./builders/refs.js";
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
export { createGraphHost, executeIsolatedGraph } from "./host/graph-host.js";
export type {
  GraphHost,
  GraphHostRunOptions,
  CreateGraphHostOptions,
  ExecuteIsolatedGraphOptions,
} from "./host/graph-host.js";
export type {
  GraphFailure,
  GraphFailureCode,
  GraphRunResult,
  RecordingMode,
  ReplayReference,
} from "./core/result.js";
export { defineGraph, defineLinearGraph, defineSingleAgentGraph } from "./builders/graph.js";
export { agentNode, codeNode, graphNode } from "./builders/node.js";
export { connect, defineTransition, entry, finish, firstMatch } from "./builders/route.js";
export { graphRef } from "./core/graph.js";
export { skillRef, toolSet } from "./builders/refs.js";
