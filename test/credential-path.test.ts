import { describe, expect, test } from "bun:test";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { createController } from "../src/controller.ts";
import { artifactStore, entry, event, preparation } from "./helpers.ts";

// The auth classifier treats a 401 status (or 401 in the message) as
// retryable, matching what the codex OAuth backend returns for a stale token.
function authError(message = "unauthorized"): Error {
  return Object.assign(new Error(`request failed with ${message}`), {
    status: 401,
  });
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp",
    model: {
      id: "active-model",
      provider: "active-provider",
      input: ["text"],
    },
    sessionManager: artifactStore(),
    modelRegistry: { getApiKey: async () => "snapshot-key" },
    ...overrides,
  };
}

// Prior roots force root condensation, so both stages run their model calls.
function compact(controller: {
  beforeCompact: (event: unknown) => Promise<unknown>;
}) {
  const priorRoots = Array.from({ length: 4 }, (_, index) => ({
    artifactId: String(100 + index),
    level: 0,
    summary: `prior root ${index}`,
    sourceEntryCount: 10,
    tokenCount: 4,
  }));
  return controller.beforeCompact(
    event(
      preparation("keep", {
        previousPreserveData: {
          ompLcmArtifactsV1: {
            version: 1,
            generation: 1,
            roots: priorRoots,
          },
        },
      }),
      [entry("old", "source detail ".repeat(60)), entry("keep")],
    ),
  );
}

describe("credential path", () => {
  test("seeds the tier snapshot and refreshes through the registry resolver", async () => {
    const resolverCalls: Array<{ lastChance: boolean; hasError: boolean }> =
      [];
    const c = ctx({
      modelRegistry: {
        getApiKey: async () => "snapshot-key",
        resolver: (): ApiKeyResolver => async (resolverContext) => {
          resolverCalls.push({
            lastChance: resolverContext.lastChance,
            hasError: resolverContext.error !== undefined,
          });
          return resolverContext.error === undefined ||
            !resolverContext.lastChance
            ? "fresh-key"
            : "rotated-key";
        },
      },
    });
    const seenKeys: string[] = [];
    const controller = createController(c, {
      complete: async (_model, _context, options) => {
        seenKeys.push(options.apiKey as string);
        if (options.apiKey === "snapshot-key") throw authError("401 expired");
        return "model prose after refresh";
      },
    });
    await compact(controller);
    // Leaf and root each start from the tier snapshot and refresh once.
    expect(seenKeys).toEqual([
      "snapshot-key",
      "fresh-key",
      "snapshot-key",
      "fresh-key",
    ]);
    expect(resolverCalls).toEqual([
      { lastChance: false, hasError: true },
      { lastChance: false, hasError: true },
    ]);
    expect(controller.status.lastSummaryQuality).toBe("model");
    expect(controller.status.lastCompletedModelSummaryCount).toBeGreaterThan(0);
    expect(controller.status.lastLeafModelError).toBeUndefined();
    expect(controller.status.lastRootModelError).toBeUndefined();
  });

  test("wraps a bare getApiKey registry with a refresh-aware resolver", async () => {
    const keyOptions: Array<{ forceRefresh?: boolean }> = [];
    const c = ctx({
      modelRegistry: {
        getApiKey: async (
          _model: unknown,
          _sessionId: string | undefined,
          options: { forceRefresh?: boolean; signal?: AbortSignal } | undefined,
        ) => {
          keyOptions.push({ forceRefresh: options?.forceRefresh });
          return options?.forceRefresh ? "fresh-key" : "cached-key";
        },
      },
    });
    const seenKeys: string[] = [];
    const controller = createController(c, {
      complete: async (_model, _context, options) => {
        seenKeys.push(options.apiKey as string);
        if (options.apiKey === "cached-key") throw authError();
        return "model prose";
      },
    });
    await compact(controller);
    // Tier gate snapshot per stage, then each stage re-mints via forceRefresh.
    expect(seenKeys).toEqual([
      "cached-key",
      "fresh-key",
      "cached-key",
      "fresh-key",
    ]);
    expect(keyOptions).toEqual([
      { forceRefresh: undefined },
      { forceRefresh: true },
      { forceRefresh: undefined },
      { forceRefresh: true },
    ]);
    expect(controller.status.lastSummaryQuality).toBe("model");
  });

  test("records exhausted auth failures and keeps deterministic fallback", async () => {
    const c = ctx();
    let failing = true;
    const controller = createController(c, {
      complete: async () => {
        if (failing) throw authError("401 token expired");
        return "model prose";
      },
    });
    await compact(controller);
    expect(controller.status.lastSummaryQuality).toBe(
      "deterministic-fallback",
    );
    expect(controller.status.lastDeterministicFallbackCount).toBeGreaterThan(0);
    expect(controller.status.lastCompletedModelSummaryCount).toBe(0);
    expect(controller.status.lastLeafModelError).toContain("401");
    expect(controller.status.lastRootModelError).toContain("401");
    // A later successful run clears the recorded errors.
    failing = false;
    await compact(controller);
    expect(controller.status.lastLeafModelError).toBeUndefined();
    expect(controller.status.lastRootModelError).toBeUndefined();
    expect(controller.status.lastSummaryQuality).toBe("model");
  });

  test("does not retry non-auth failures", async () => {
    let calls = 0;
    const c = ctx();
    const controller = createController(c, {
      complete: async () => {
        calls++;
        throw new Error("model exploded");
      },
    });
    await compact(controller);
    // Two convergence attempts per stage (normal + aggressive), no auth retry.
    expect(calls).toBe(4);
    expect(controller.status.lastLeafModelError).toContain("model exploded");
    expect(controller.status.lastRootModelError).toContain("model exploded");
  });

  test("records a missing-key failure when the registry cannot resolve anything", async () => {
    const c = ctx({ modelRegistry: {} });
    const controller = createController(c);
    await compact(controller);
    expect(controller.status.lastSummaryQuality).toBe(
      "deterministic-fallback",
    );
    expect(controller.status.lastLeafModelError).toBeDefined();
    expect(controller.status.lastRootModelError).toBeDefined();
  });

  test("passes the unwrapped tier model (with api) to the completion", async () => {
    const TINY = {
      id: "tiny-model",
      provider: "google-antigravity",
      api: "google-gemini-cli",
      input: ["text"],
    };
    const c = ctx({
      models: {
        resolve: (spec: string) => (spec === "@tiny" ? TINY : undefined),
      },
      modelRegistry: { getApiKey: async () => "tiny-key" },
    });
    const seenModels: unknown[] = [];
    const controller = createController(c, {
      complete: async (model) => {
        seenModels.push(model);
        return "model prose";
      },
    });
    await compact(controller);
    // Regression: the tier result wraps the model in TierModelInfo; the call
    // must receive the unwrapped candidate or dispatch fails with
    // "Unhandled API: undefined" and everything degrades to deterministic.
    expect(seenModels.length).toBeGreaterThan(0);
    const first = seenModels[0] as { id?: unknown; api?: unknown };
    expect(first.id).toBe("tiny-model");
    expect(first.api).toBe("google-gemini-cli");
    expect(controller.status.lastSummaryQuality).toBe("model");
    expect(controller.status.lastLeafModelError).toBeUndefined();
  });

  test("records tier candidate rejections in status", async () => {
    const TINY = { id: "tiny-model", provider: "openai", input: ["text"] };
    const SMOL = { id: "smol-model", provider: "deepseek", input: ["text"] };
    const c = ctx({
      models: {
        resolve: (spec: string) =>
          spec === "@tiny" ? TINY : spec === "@smol" ? SMOL : undefined,
      },
      modelRegistry: {
        getApiKey: async (model: unknown) =>
          model === SMOL ? "smol-key" : undefined,
      },
    });
    const controller = createController(c, {
      complete: async () => "model prose",
    });
    await compact(controller);
    expect(controller.status.lastTierRejections).toEqual([
      "leaf:tiny:openai/tiny-model:no-key",
    ]);
    expect(controller.status.lastLeafSummaryModel).toBe("deepseek/smol-model");
    expect(controller.status.lastSummaryQuality).toBe("model");
  });
});
