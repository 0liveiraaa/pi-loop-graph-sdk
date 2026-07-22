// ============================================================
//  Loop Graph Extension — pi 自动加载入口
// ============================================================
//
//  业务 extension 通常应直接使用 createLoopGraphExtension(pi)，
//  注册自己的图并显式暴露 command/tool。
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopGraphExtension } from "./loop-graph-extension.js";

export default function loopGraphDebugExtension(pi: ExtensionAPI) {
  createLoopGraphExtension(pi);
}
