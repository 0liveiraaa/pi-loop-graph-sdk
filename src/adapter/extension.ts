// ============================================================
//  Loop Graph Debug/Demo Extension — pi 入口
// ============================================================
//
//  这是 SDK 自带的可选 debug/demo extension。
//  使用 createLoopGraphExtension(pi, { demoGraphs: true })
//  创建运行时并注册所有测试图。
//
//  业务 extension 不应依赖此文件；应直接使用
//  createLoopGraphExtension(pi) 创建自己的运行时。
// ============================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLoopGraphExtension } from "./loop-graph-extension.js";

export default function loopGraphDebugExtension(pi: ExtensionAPI) {
  createLoopGraphExtension(pi, { demoGraphs: true });
}
