/**
 * Kim Runtime
 * 保存 OpenClaw runtime 的引用，供其他模块使用
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let kimRuntime: PluginRuntime | null = null;

export function setKimRuntime(runtime: PluginRuntime): void {
  kimRuntime = runtime;
}

export function getKimRuntime(): PluginRuntime {
  if (!kimRuntime) {
    throw new Error("Kim runtime not initialized");
  }
  return kimRuntime;
}
