// Loop Graph SDK — public library API
//
//  作为 library 使用（推荐）：
//    import { createLoopGraphExtension, Graph, ... } from "pi-loop-graph-sdk";
//
//  作为 debug/demo extension 使用：
//    pi install git:github.com/0liveiraaa/pi-loop-graph-sdk@v0.1
//    （自动加载 ./extension → 注册测试图）

// ── 实例运行时工厂（新 API，推荐）──
export { createLoopGraphExtension } from "./adapter/loop-graph-extension.js";
export type {
  LoopGraphExtension,
  LoopGraphExtensionOptions,
} from "./adapter/loop-graph-extension.js";

// ── 图注册表（新 API）──
export { GraphRegistry } from "./registry.js";
export type { ExecuteGraph } from "./registry.js";

// ── 工具解析 ──
export { resolveNodeTools } from "./tools-resolve.js";

// ── execute 工厂 ──
export { createAgentExecute } from "./agent-execute.js";
export type { AgentExecuteOptions } from "./agent-execute.js";

// ── 隔离图执行载体 ──
export { IsolatedSessionGraphHost } from "./adapter/graph-execution-host.js";
export { createIsolatedGraphSessionFactory } from "./adapter/isolated-graph-session.js";
export type {
  GraphExecutionHost,
  GraphInvocationKind,
  GraphRunRequest,
  GraphRunResult,
  IsolatedGraphSession,
  IsolatedGraphSessionFactory,
  IsolatedSessionGraphHostOptions,
} from "./adapter/graph-execution-host.js";
export type { IsolatedGraphSessionFactoryOptions } from "./adapter/isolated-graph-session.js";

// ── 核心类型 ──
export * from "./type.js";

// ── 运行时与路由 ──
export { GraphRuntime } from "./runtime.js";
export type { CallFrame } from "./runtime.js";
export { validateGraph, assertValidGraph, validateGraphTools } from "./validate.js";
export type { GraphValidationIssue } from "./validate.js";
export { selectEdge } from "./router.js";

// ── 消息投影（高级）──
export { projectMessages, defaultFrameFormatter } from "./adapter/projection.js";
export type { ProjectionInput, MessageEntry, EdgeChoice } from "./adapter/projection.js";

// ── @deprecated 全局兼容层（向后兼容旧代码）──
export {
  registerGraph,
  initRegistry,
  findEntry,
} from "./registry.js";
