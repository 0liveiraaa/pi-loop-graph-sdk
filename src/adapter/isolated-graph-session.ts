import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AuthStorage,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ContextFrame, GraphRunRequest } from "../type.js";
import { createLoopGraphExtension, type LoopGraphExtension } from "./loop-graph-extension.js";
import type {
  IsolatedGraphSession,
  IsolatedGraphSessionFactory,
} from "./graph-execution-host.js";

export interface IsolatedGraphSessionFactoryOptions {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  cwd?: string;
  agentDir?: string;
  model?: CreateAgentSessionOptions["model"];
  defaultTools?: string[];
  customTools?: ToolDefinition[];
  skillBasePath?: string;
  frameFormatter?: (frames: ContextFrame[]) => string | null;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
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
  return async (_request: GraphRunRequest): Promise<IsolatedGraphSession> => {
    const cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? getAgentDir();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
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
            defaultTools: options.defaultTools,
            skillBasePath: options.skillBasePath,
            frameFormatter: options.frameFormatter,
          });
        },
      ],
    });
    await resourceLoader.reload();

    const customToolNames = (options.customTools ?? []).map((tool) => tool.name);
    const activeTools = [
      "read",
      ...(options.defaultTools ?? []),
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
        return runtime.executeGraph(graph, {
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
