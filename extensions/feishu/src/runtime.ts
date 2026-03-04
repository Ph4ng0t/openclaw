import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

export function setFeishuRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getFeishuRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Feishu runtime not initialized");
  }
  return runtime;
}

export function loadFeishuRuntimeConfig<T>(fallback: T): T {
  const loaded = (runtime as Partial<PluginRuntime> | null)?.config?.loadConfig?.() as
    | T
    | undefined;
  return isNonEmptyObject(loaded) ? loaded : fallback;
}
