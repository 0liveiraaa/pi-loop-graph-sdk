// ============================================================
//  Loop Graph SDK — 对外导出
// ============================================================

// 核心类型
export * from "./type.js";

// 适配层（pi extension 专用）
export { PiNodeContext } from "./adapter/pi-node-context.js";
export type { PiNodeContextOptions } from "./adapter/pi-node-context.js";
export { buildNodeEntryMessage, isNodeEntryMessage } from "./adapter/node-entry.js";
export { createCompleteTool, COMPLETE_TOOL_NAME } from "./adapter/complete-tool.js";
export type { CompleteToolParams } from "./adapter/complete-tool.js";
export { normalizeTrigger } from "./adapter/trigger.js";
export { serializeInstance, deserializeInstance, hasActiveRun } from "./adapter/state-store.js";
export type { PersistedInstance } from "./adapter/state-store.js";
