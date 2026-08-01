import { PLUGIN_NAME, parseRenderer, type Renderer } from "./contracts.ts";
import type { SummaryModelTier } from "./tiers.ts";

export type { Renderer };
export { PLUGIN_NAME };
export interface LcmConfig {
  renderer: Renderer;
  leafSummaryModel: SummaryModelTier; // default "tiny"
  rootSummaryModel: SummaryModelTier; // default "smol"
  summaryConcurrency: number; // integer 1..8, default 4
  summaryBatchInputTokens: number; // integer 12_000..96_000, default 48_000
  handlerDeadlineMs: number; // integer 10_000..27_000, default 24_000
}

const TIER_DEFAULTS: Record<
  "leafSummaryModel" | "rootSummaryModel",
  SummaryModelTier
> = {
  leafSummaryModel: "tiny",
  rootSummaryModel: "smol",
};

function tierValue(
  value: unknown,
  fallback: SummaryModelTier,
): SummaryModelTier {
  if (typeof value !== "string") return fallback;
  return value === "tiny" || value === "smol" || value === "active"
    ? value
    : fallback;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function rendererFromSettings(settings: unknown): Renderer {
  const value =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).renderer
      : undefined;
  return parseRenderer(value) ?? "auto";
}

/** Parse plugin settings defensively; never throws; unknown values fall back to defaults. */
export function configFromSettings(settings: unknown): LcmConfig {
  const record =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)
      : undefined;
  return {
    renderer: rendererFromSettings(settings),
    leafSummaryModel: tierValue(
      record?.leafSummaryModel,
      TIER_DEFAULTS.leafSummaryModel,
    ),
    rootSummaryModel: tierValue(
      record?.rootSummaryModel,
      TIER_DEFAULTS.rootSummaryModel,
    ),
    summaryConcurrency: clampInt(record?.summaryConcurrency, 1, 8, 4),
    summaryBatchInputTokens: clampInt(
      record?.summaryBatchInputTokens,
      12_000,
      96_000,
      48_000,
    ),
    handlerDeadlineMs: clampInt(
      record?.handlerDeadlineMs,
      10_000,
      27_000,
      24_000,
    ),
  };
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
  return configFromSettings(settings);
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
