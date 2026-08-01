import { describe, expect, test } from "bun:test";
import packageMetadata from "../package.json" with { type: "json" };
import {
  configFromSettings,
  getConfig,
  type LcmConfig,
  loadConfig,
  PLUGIN_NAME,
  readConfig,
} from "../src/config.ts";

const DEFAULTS: LcmConfig = {
  renderer: "auto",
  leafSummaryModel: "tiny",
  rootSummaryModel: "smol",
  summaryConcurrency: 4,
  summaryBatchInputTokens: 48_000,
  handlerDeadlineMs: 24_000,
};

describe("configFromSettings", () => {
  test("defaults for empty or absent settings", () => {
    expect(configFromSettings(undefined)).toEqual(DEFAULTS);
    expect(configFromSettings(null)).toEqual(DEFAULTS);
    expect(configFromSettings({})).toEqual(DEFAULTS);
    expect(configFromSettings("garbage")).toEqual(DEFAULTS);
    expect(configFromSettings(42)).toEqual(DEFAULTS);
  });

  test("accepts valid values per field", () => {
    const config = configFromSettings({
      renderer: "context-full",
      leafSummaryModel: "active",
      rootSummaryModel: "tiny",
      summaryConcurrency: 8,
      summaryBatchInputTokens: 12_000,
      handlerDeadlineMs: 10_000,
    });
    expect(config.renderer).toBe("context-full");
    expect(config.leafSummaryModel).toBe("active");
    expect(config.rootSummaryModel).toBe("tiny");
    expect(config.summaryConcurrency).toBe(8);
    expect(config.summaryBatchInputTokens).toBe(12_000);
    expect(config.handlerDeadlineMs).toBe(10_000);

    const other = configFromSettings({
      leafSummaryModel: "smol",
      rootSummaryModel: "active",
      summaryConcurrency: 1,
      summaryBatchInputTokens: 96_000,
      handlerDeadlineMs: 27_000,
    });
    expect(other.leafSummaryModel).toBe("smol");
    expect(other.rootSummaryModel).toBe("active");
    expect(other.summaryConcurrency).toBe(1);
    expect(other.summaryBatchInputTokens).toBe(96_000);
    expect(other.handlerDeadlineMs).toBe(27_000);
  });

  test("out-of-range integers clamp to nearest bound", () => {
    const low = configFromSettings({
      summaryConcurrency: 0,
      summaryBatchInputTokens: 1_000,
      handlerDeadlineMs: 5_000,
    });
    expect(low.summaryConcurrency).toBe(1);
    expect(low.summaryBatchInputTokens).toBe(12_000);
    expect(low.handlerDeadlineMs).toBe(10_000);

    const high = configFromSettings({
      summaryConcurrency: 99,
      summaryBatchInputTokens: 999_999,
      handlerDeadlineMs: 30_000,
    });
    expect(high.summaryConcurrency).toBe(8);
    expect(high.summaryBatchInputTokens).toBe(96_000);
    expect(high.handlerDeadlineMs).toBe(27_000);
  });

  test("non-numeric garbage falls back to defaults", () => {
    const badValues = [
      "12",
      NaN,
      null,
      undefined,
      {},
      [],
      true,
      -Infinity,
      Infinity,
    ];
    for (const bad of badValues) {
      const config = configFromSettings({
        summaryConcurrency: bad,
        summaryBatchInputTokens: bad,
        handlerDeadlineMs: bad,
      });
      expect(config.summaryConcurrency).toBe(DEFAULTS.summaryConcurrency);
      expect(config.summaryBatchInputTokens).toBe(
        DEFAULTS.summaryBatchInputTokens,
      );
      expect(config.handlerDeadlineMs).toBe(DEFAULTS.handlerDeadlineMs);
    }
  });

  test("fractional values fall back to defaults (not floored)", () => {
    const config = configFromSettings({
      summaryConcurrency: 3.5,
      summaryBatchInputTokens: 48_000.5,
      handlerDeadlineMs: 24_000.9,
    });
    expect(config.summaryConcurrency).toBe(DEFAULTS.summaryConcurrency);
    expect(config.summaryBatchInputTokens).toBe(
      DEFAULTS.summaryBatchInputTokens,
    );
    expect(config.handlerDeadlineMs).toBe(DEFAULTS.handlerDeadlineMs);
  });

  test("unknown tier values fall back to the tier defaults", () => {
    const badValues = ["large", "TINY", "smoll", 1, null, undefined, ["tiny"]];
    for (const bad of badValues) {
      const config = configFromSettings({
        leafSummaryModel: bad,
        rootSummaryModel: bad,
      });
      expect(config.leafSummaryModel).toBe(DEFAULTS.leafSummaryModel);
      expect(config.rootSummaryModel).toBe(DEFAULTS.rootSummaryModel);
    }
  });

  test("renderer behavior unchanged", () => {
    expect(configFromSettings({ renderer: "auto" }).renderer).toBe("auto");
    expect(configFromSettings({ renderer: "context-full" }).renderer).toBe(
      "context-full",
    );
    expect(configFromSettings({ renderer: "snapcompact" }).renderer).toBe(
      "snapcompact",
    );
    expect(configFromSettings({ renderer: "unknown" }).renderer).toBe("auto");
    expect(configFromSettings({ renderer: 7 }).renderer).toBe("auto");
    expect(configFromSettings({ renderer: null }).renderer).toBe("auto");
  });

  test("never throws on hostile input shapes", () => {
    const hostile = {
      leafSummaryModel: { toString: () => 1 },
      summaryConcurrency: { valueOf: () => 7 },
      handlerDeadlineMs: Symbol("x"),
    };
    expect(() => configFromSettings(hostile)).not.toThrow();
    expect(configFromSettings(hostile)).toEqual(DEFAULTS);
  });
});

describe("readConfig", () => {
  test("returns the full config with defaults when settings absent", async () => {
    const seen: string[] = [];
    const config = await readConfig(
      { cwd: "/tmp" },
      {
        getPluginSettings: async (name, cwd) => {
          seen.push(name, cwd ?? "");
          return undefined;
        },
      },
    );
    expect(config).toEqual(DEFAULTS);
    expect(seen).toEqual([PLUGIN_NAME, "/tmp"]);
  });

  test("applies settings through configFromSettings", async () => {
    const config = await readConfig(
      { cwd: "/tmp" },
      {
        getPluginSettings: async () => ({
          leafSummaryModel: "active",
          summaryConcurrency: 0,
          handlerDeadlineMs: 30_000,
        }),
      },
    );
    expect(config.leafSummaryModel).toBe("active");
    expect(config.rootSummaryModel).toBe(DEFAULTS.rootSummaryModel);
    expect(config.summaryConcurrency).toBe(1);
    expect(config.handlerDeadlineMs).toBe(27_000);
  });

  test("aliases and plugin name remain exported", () => {
    expect(getConfig).toBe(readConfig);
    expect(loadConfig).toBe(readConfig);
    expect(PLUGIN_NAME).toBe("omp-lcm-inspired-compaction");
  });
});

describe("package.json omp.settings", () => {
  test("registers the five contract entries with defaults", () => {
    const settings = packageMetadata.omp.settings as Record<string, unknown>;
    const expected: Record<string, { type: string; default: unknown }> = {
      leafSummaryModel: { type: "enum", default: "tiny" },
      rootSummaryModel: { type: "enum", default: "smol" },
      summaryConcurrency: { type: "number", default: 4 },
      summaryBatchInputTokens: { type: "number", default: 48000 },
      handlerDeadlineMs: { type: "number", default: 24000 },
    };
    for (const [key, shape] of Object.entries(expected)) {
      const entry = settings[key] as { type?: string; default?: unknown };
      expect(entry, `missing settings entry ${key}`).toBeDefined();
      expect(entry.type).toBe(shape.type);
      expect(entry.default).toBe(shape.default);
    }
  });
});
