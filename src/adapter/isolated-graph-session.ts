import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AuthStorage,
  type CompactionSettings,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ContextFrame, GraphRunRequest } from "../type.js";
import type { NodeContextRenderer } from "./projection.js";
import {
  createLoopGraphExtension,
  type LoopGraphExtension,
  type LoopGraphLimits,
  type CompletionFeedbackFormatter,
  type ContextRendererRegistry,
} from "./loop-graph-extension.js";
import type { ModelMessageFormatter } from "./model-messages.js";
import type { ToolResolver } from "../tools-resolve.js";
import type { LoopGraphLogger, LoopGraphTraceSink } from "./observability.js";
import type {
  SkillContentProvider,
  SkillContentRenderer,
  SkillFailurePolicies,
} from "./skill-content.js";
import type {
  DelegateHostFactory,
  IsolatedGraphSession,
  IsolatedGraphSessionFactory,
} from "./graph-execution-host.js";
import { IsolatedSessionGraphHost } from "./graph-execution-host.js";
import type { HostBaseline } from "../host/baseline.js";
import type { SkillCatalog } from "../host/skill-catalog.js";
import type { ToolCatalog, UnsafeToolResolver } from "../host/tool-catalog.js";

export interface IsolatedGraphSessionFactoryOptions {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  cwd?: string;
  agentDir?: string;
  model?: CreateAgentSessionOptions["model"];
  customTools?: ToolDefinition[];
  toolCatalog?: ToolCatalog;
  skillCatalog?: SkillCatalog;
  unsafeToolResolver?: UnsafeToolResolver;
  baseline?: HostBaseline;
  skillBasePath?: string;
  frameFormatter?: (frames: ContextFrame[]) => string | null;
  limits?: LoopGraphLimits;
  contextRenderer?: NodeContextRenderer;
  modelMessageFormatter?: Partial<ModelMessageFormatter>;
  completionFeedbackFormatter?: CompletionFeedbackFormatter;
  outputContractMaxBytes?: number;
  skillProvider?: SkillContentProvider;
  skillRenderer?: SkillContentRenderer;
  skillFailure?: SkillFailurePolicies;
  contextRenderers?: ContextRendererRegistry;
  toolResolver?: ToolResolver;
  traceSink?: LoopGraphTraceSink;
  logger?: LoopGraphLogger;
  debug?: boolean;
  debugLogPath?: string;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** 省略时遵循 pi 默认 compaction；可由 host 显式覆盖。 */
  compaction?: CompactionSettings;
  /** 供子图继续使用 delegate；runtime-only adapter 不注册对外入口。 */
  createDelegateHost?: DelegateHostFactory;
}

/**
 * 使用 pi 官方 in-memory AgentSession 创建隔离图执行环境。
 *
 * 子会话通过 inline extension factory 安装同一套 LoopGraph Runtime，避免维护
 * 第二套 graph loop。runtimeOnly 模式只保留运行钩子，不注册对外命令或资源通知。
 */
export function createIsolatedGraphSessionFactory(
  options: IsolatedGraphSessionFactoryOptions,
): IsolatedGraphSessionFactory {
  const legacyOptions = options as IsolatedGraphSessionFactoryOptions & {
    readonly defaultTools?: string[];
  };
  return async (_request: GraphRunRequest): Promise<IsolatedGraphSession> => {
    const cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? getAgentDir();
    const settingsManager = SettingsManager.inMemory(
      options.compaction ? { compaction: options.compaction } : undefined,
    );
    let loop: LoopGraphExtension | null = null;

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          loop = createLoopGraphExtension(pi, {
            runtimeOnly: true,
            defaultTools: legacyOptions.defaultTools,
            toolCatalog: options.toolCatalog,
            skillCatalog: options.skillCatalog,
            unsafeToolResolver: options.unsafeToolResolver,
            baseline: options.baseline,
            skillBasePath: options.skillBasePath,
            frameFormatter: options.frameFormatter,
            createDelegateHost: options.createDelegateHost,
            delegateTools: options.customTools,
            delegateCompaction: options.compaction,
            limits: options.limits,
            contextRenderer: options.contextRenderer,
            modelMessageFormatter: options.modelMessageFormatter,
            completionFeedbackFormatter: options.completionFeedbackFormatter,
            outputContractMaxBytes: options.outputContractMaxBytes,
            skillProvider: options.skillProvider,
            skillRenderer: options.skillRenderer,
            skillFailure: options.skillFailure,
            contextRenderers: options.contextRenderers,
            toolResolver: options.toolResolver,
            traceSink: options.traceSink,
            logger: options.logger,
            debug: options.debug,
            debugLogPath: options.debugLogPath,
          } as any);
        },
      ],
    });
    await resourceLoader.reload();

    const customToolNames = (options.customTools ?? []).map((tool) => tool.name);
    const activeTools = [
      "read",
      ...(legacyOptions.defaultTools ?? []),
      ...customToolNames,
      "__graph_complete__",
    ];

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage: options.authStorage,
      modelRegistry: options.modelRegistry,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? "off",
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      customTools: options.customTools,
      tools: [...new Set(activeTools)],
    });

    if (!loop) {
      session.dispose();
      throw new Error("runtime-only LoopGraph extension 初始化失败");
    }
    const runtime = loop as LoopGraphExtension;

    return {
      run(graph, request) {
        return (runtime as any).executeGraph(graph, {
          source: "tool",
          params: request.background,
        });
      },
      abort() {
        return session.abort();
      },
      dispose() {
        session.dispose();
      },
    };
  };
}

/**
 * 构造可递归 delegate 的一次性 host factory。每次调用创建新 host/session，
 * 子 session 内的 delegate graph-node 继续复用同一份认证、模型与真实工具实现。
 */
export function createIsolatedDelegateHostFactory(
  options: Omit<IsolatedGraphSessionFactoryOptions, "createDelegateHost">,
): DelegateHostFactory {
  let createSession!: IsolatedGraphSessionFactory;
  const createHost: DelegateHostFactory = async () =>
    new IsolatedSessionGraphHost({ createSession });
  createSession = createIsolatedGraphSessionFactory({
    ...options,
    createDelegateHost: createHost,
  });
  return createHost;
}
