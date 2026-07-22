import type { CompactionSettings, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ContextFrame, CompletionSubmissionDecision } from "../../src/type.js";
import type { NodeContextRenderer } from "../../src/adapter/projection.js";
import type { ModelMessageFormatter } from "../../src/adapter/model-messages.js";
import type { ToolResolver } from "../../src/tools-resolve.js";
import type { LoopGraphLogger, LoopGraphTraceSink } from "../../src/adapter/observability.js";
import type { SkillContentProvider, SkillContentRenderer, SkillFailurePolicies } from "../../src/adapter/skill-content.js";
import type { MechanismRuntimeOptions } from "../../src/adapter/mechanism-runtime.js";
import type { DelegateHostFactory } from "../../src/adapter/graph-execution-host.js";

export interface LoopGraphLimits {
  rootMaxSteps?: number;
  childMaxSteps?: number;
  agentRunTimeoutMs?: number;
  completionValidationTimeoutMs?: number;
}

export interface ContextRendererRegistry {
  graphs?: Readonly<Record<string, NodeContextRenderer>>;
  nodes?: Readonly<Record<string, Readonly<Record<string, NodeContextRenderer>>>>;
}

export interface CompletionFeedbackInput {
  nodeId: string;
  decision: CompletionSubmissionDecision;
}

export type CompletionFeedbackFormatter = (input: CompletionFeedbackInput) => string;

export interface LoopGraphExtensionOptions {
  runtimeOnly?: boolean;
  demoGraphs?: boolean;
  defaultTools?: string[];
  skillBasePath?: string;
  frameFormatter?: (frames: ContextFrame[]) => string | null;
  createDelegateHost?: DelegateHostFactory;
  delegateTools?: ToolDefinition[];
  delegateCompaction?: CompactionSettings;
  toolResultMaxBytes?: number;
  formatToolResult?: (...args: readonly any[]) => string;
  toolResolver?: ToolResolver;
  traceSink?: LoopGraphTraceSink;
  logger?: LoopGraphLogger;
  debug?: boolean;
  debugLogPath?: string;
  limits?: LoopGraphLimits;
  contextRenderer?: NodeContextRenderer;
  modelMessageFormatter?: Partial<ModelMessageFormatter>;
  completionFeedbackFormatter?: CompletionFeedbackFormatter;
  outputContractMaxBytes?: number;
  skillProvider?: SkillContentProvider;
  skillRenderer?: SkillContentRenderer;
  skillFailure?: SkillFailurePolicies;
  contextRenderers?: ContextRendererRegistry;
  mechanismRuntime?: MechanismRuntimeOptions;
}

export interface LoopGraphExtension {
  registerGraph(graph: any): void;
  executeGraph(graph: any, trigger: any, options?: { contextRenderer?: NodeContextRenderer }): Promise<any>;
}

export declare function createLoopGraphExtension(
  pi: ExtensionAPI,
  options?: LoopGraphExtensionOptions,
): LoopGraphExtension;

export declare function findCompactedFrameBase(...args: readonly any[]): any;
