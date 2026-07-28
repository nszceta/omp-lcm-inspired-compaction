import { PLUGIN_NAME, parseRenderer, type Renderer } from "./contracts.ts";

export type { Renderer };
export { PLUGIN_NAME };
export interface LcmConfig {
  renderer: Renderer;
}
export function rendererFromSettings(settings: unknown): Renderer {
  const value =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).renderer
      : undefined;
  return parseRenderer(value) ?? "auto";
}
export async function readConfig(
  ctx: { cwd?: string },
  deps: { getPluginSettings?: (name: string, cwd?: string) => unknown } = {},
): Promise<LcmConfig> {
  let settings: unknown;
  if (deps.getPluginSettings)
    settings = await deps.getPluginSettings(PLUGIN_NAME, ctx.cwd);
  else {
    try {
      const mod = await import(
        "@oh-my-pi/pi-coding-agent/extensibility/plugins"
      );
      settings = await (mod as any).getPluginSettings(PLUGIN_NAME, ctx.cwd);
    } catch {
      settings = undefined;
    }
  }
  return { renderer: rendererFromSettings(settings) };
}
export async function persistRenderer(
  ctx: { cwd?: string },
  renderer: Renderer,
  manager: any,
): Promise<void> {
  if (!manager) throw new Error("Plugin manager unavailable");
  const methods = [
    "setPluginSetting",
    "setSetting",
    "updateSetting",
    "set",
  ].filter((name) => typeof manager[name] === "function");
  if (!methods.length)
    throw new Error("Plugin manager cannot persist settings");
  const fn = manager[methods[0]].bind(manager);
  let last: unknown;
  for (const args of [
    [PLUGIN_NAME, "renderer", renderer, ctx.cwd],
    [PLUGIN_NAME, { renderer }, ctx.cwd],
    ["renderer", renderer, ctx.cwd],
  ]) {
    try {
      await fn(...args);
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
export const getConfig = readConfig;
export const loadConfig = readConfig;
