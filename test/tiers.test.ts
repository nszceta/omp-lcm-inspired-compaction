import { describe, expect, test } from "bun:test";
import type { TierResolverDeps } from "../src/tiers.ts";
import {
  batchBudgetFor,
  MIN_VIABLE_BATCH_TOKENS,
  preferredChain,
  resolveSummaryModel,
  SUMMARY_RESERVE_TOKENS,
  TIER_CHAINS,
} from "../src/tiers.ts";

type FakeModel = Record<string, unknown>;

function fakeModel(overrides: Record<string, unknown> = {}): FakeModel {
  return {
    id: "model",
    provider: "openai",
    input: ["text"],
    contextWindow: 64_000,
    ...overrides,
  };
}

type KeyCall = {
  model: unknown;
  sessionId?: string;
  options?: { signal?: AbortSignal };
};

interface Harness {
  deps: TierResolverDeps;
  resolveCalls: string[];
  listCalls: number;
  currentCalls: number;
  keyCalls: KeyCall[];
}

/** Adversarial facade/registry: records every consult and keys only what it is given. */
function harness(
  models: Record<string, FakeModel | undefined>,
  keys: Record<string, string>,
  fallbackKey?: string,
): Harness {
  const resolveCalls: string[] = [];
  let listCalls = 0;
  let currentCalls = 0;
  const keyCalls: KeyCall[] = [];
  const deps: TierResolverDeps = {
    models: {
      resolve(spec: string) {
        resolveCalls.push(spec);
        return models[spec];
      },
      list() {
        listCalls += 1;
        return Object.values(models).filter(
          (model): model is FakeModel => model !== undefined,
        );
      },
      current() {
        currentCalls += 1;
        return undefined;
      },
    },
    modelRegistry: {
      async getApiKey(model, sessionId, options) {
        keyCalls.push({ model, sessionId, options });
        if (
          typeof model !== "object" ||
          model === null ||
          !("id" in model) ||
          typeof model.id !== "string"
        ) {
          return fallbackKey;
        }
        return keys[model.id];
      },
    },
  };
  return { deps, resolveCalls, listCalls, currentCalls, keyCalls };
}

const TINY = fakeModel({ id: "tiny-model", contextWindow: 32_000 });
const SMOL = fakeModel({ id: "smol-model", contextWindow: 64_000 });
const ACTIVE = fakeModel({
  id: "active-model",
  provider: "anthropic",
  contextWindow: 200_000,
});
const KEYS = {
  "tiny-model": "key-tiny",
  "smol-model": "key-smol",
  "active-model": "key-active",
};

// OMP's getModelRoleAlias only recognizes @-prefixed aliases; a bare role
// name is a literal model-id pattern and must never be requested.
const ROLE_ALIAS_SPEC = /^@(?:tiny|smol)$/u;

describe("frozen constants and chains", () => {
  test("chains and token constants match the contract", () => {
    expect(TIER_CHAINS.leaf).toEqual(["tiny", "smol", "active"]);
    expect(TIER_CHAINS.root).toEqual(["smol", "active", "tiny"]);
    expect(SUMMARY_RESERVE_TOKENS).toBe(8_000);
    expect(MIN_VIABLE_BATCH_TOKENS).toBe(2_048);
  });

  test("preferredChain puts the configured tier first and keeps the rest", () => {
    expect(preferredChain("smol", TIER_CHAINS.leaf)).toEqual([
      "smol",
      "tiny",
      "active",
    ]);
    expect(preferredChain("active", TIER_CHAINS.leaf)).toEqual([
      "active",
      "tiny",
      "smol",
    ]);
    expect(preferredChain("tiny", TIER_CHAINS.root)).toEqual([
      "tiny",
      "smol",
      "active",
    ]);
    expect(preferredChain("smol", TIER_CHAINS.root)).toEqual([
      "smol",
      "active",
      "tiny",
    ]);
    // Defaults reproduce the canonical chains exactly (no reordering).
    expect(preferredChain("tiny", TIER_CHAINS.leaf)).toEqual([
      "tiny",
      "smol",
      "active",
    ]);
    expect(preferredChain("smol", TIER_CHAINS.root)).toEqual([
      "smol",
      "active",
      "tiny",
    ]);
  });
});

describe("resolveSummaryModel tier order", () => {
  test("leaf chain prefers TINY when it is keyed", async () => {
    const h = harness({ "@tiny": TINY, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved?.role).toBe("tiny");
    expect(resolved?.model.id).toBe("tiny-model");
    expect(resolved?.model.provider).toBe("openai");
    expect(resolved?.label).toBe("openai/tiny-model");
    expect(resolved?.apiKey).toBe("key-tiny");
    expect(resolved?.model.model).toBe(TINY);
    expect(h.resolveCalls).toEqual(["@tiny"]);
    expect(h.keyCalls.map((call) => call.model)).toEqual([TINY]);
  });

  test("root chain prefers SMOL", async () => {
    const h = harness({ "@tiny": TINY, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.root, h.deps);
    expect(resolved?.role).toBe("smol");
    expect(resolved?.model.id).toBe("smol-model");
    expect(resolved?.label).toBe("openai/smol-model");
    expect(h.resolveCalls).toEqual(["@smol"]);
  });

  test("missing credentials advance to the next tier", async () => {
    const h = harness(
      { "@tiny": TINY, "@smol": SMOL },
      { "smol-model": "key-smol" },
    );
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved?.role).toBe("smol");
    expect(resolved?.label).toBe("openai/smol-model");
    expect(h.resolveCalls).toEqual(["@tiny", "@smol"]);
    // Every candidate in chain order had its own key lookup attempted.
    expect(h.keyCalls.map((call) => call.model)).toEqual([TINY, SMOL]);
  });

  test("no key anywhere resolves undefined and consults no other source", async () => {
    const h = harness({ "@tiny": TINY, "@smol": SMOL }, {});
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved).toBeUndefined();
    expect(h.resolveCalls).toEqual(["@tiny", "@smol"]);
    expect(h.keyCalls.map((call) => call.model)).toEqual([TINY, SMOL]);
    // Only @-prefixed role aliases may ever reach the facade, and only
    // resolve() may be used: no list()/current() enumeration, no other source.
    expect(h.resolveCalls.every((spec) => ROLE_ALIAS_SPEC.test(spec))).toBe(
      true,
    );
    expect(h.listCalls).toBe(0);
    expect(h.currentCalls).toBe(0);
  });

  test("root chain skips an absent active model between smol and tiny", async () => {
    const h = harness({ "@tiny": TINY, "@smol": SMOL }, {});
    const resolved = await resolveSummaryModel(TIER_CHAINS.root, h.deps);
    expect(resolved).toBeUndefined();
    expect(h.resolveCalls).toEqual(["@smol", "@tiny"]);
    expect(h.keyCalls.map((call) => call.model)).toEqual([SMOL, TINY]);
  });

  test("resolve is only ever asked for @-prefixed role aliases", async () => {
    const h = harness({ "@tiny": TINY, "@smol": SMOL }, KEYS);
    await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    await resolveSummaryModel(TIER_CHAINS.root, h.deps);
    expect(h.resolveCalls.length).toBeGreaterThan(0);
    for (const spec of h.resolveCalls) {
      expect(ROLE_ALIAS_SPEC.test(spec)).toBe(true);
    }
    // Never a bare role name (would be a literal model-id pattern) and never
    // any other string.
    expect(h.resolveCalls).not.toContain("tiny");
    expect(h.resolveCalls).not.toContain("smol");
    expect(h.resolveCalls).not.toContain("active");
    expect(h.listCalls).toBe(0);
    expect(h.currentCalls).toBe(0);
  });
});

describe("candidate eligibility", () => {
  test("models accepting text plus image are eligible", async () => {
    const tinyMultimodal = fakeModel({
      id: "tiny-model",
      input: ["text", "image"],
    });
    const h = harness({ "@tiny": tinyMultimodal, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved?.role).toBe("tiny");
  });

  test("image-only model advances the chain", async () => {
    const tinyImageOnly = fakeModel({ id: "tiny-model", input: ["image"] });
    const h = harness({ "@tiny": tinyImageOnly, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved?.role).toBe("smol");
    expect(resolved?.label).toBe("openai/smol-model");
  });

  test("absent, empty string, and empty array input are all text-capable", async () => {
    const absentInput: FakeModel = {
      id: "tiny-model",
      provider: "openai",
      contextWindow: 32_000,
    };
    const emptyString = fakeModel({ id: "tiny-model", input: "" });
    const emptyArray = fakeModel({ id: "tiny-model", input: [] });
    for (const candidate of [absentInput, emptyString, emptyArray]) {
      const h = harness({ "@tiny": candidate, "@smol": SMOL }, KEYS);
      const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
      expect(resolved?.role).toBe("tiny");
      expect(resolved?.model.model).toBe(candidate);
    }
  });

  test("non-array input field is not text-capable and advances", async () => {
    const stringInput = fakeModel({ id: "tiny-model", input: "text" });
    const h = harness({ "@tiny": stringInput, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved?.role).toBe("smol");
  });

  test("non-object candidates are skipped", async () => {
    const h = harness(
      { "@tiny": "tiny-model" as unknown as FakeModel, "@smol": SMOL },
      KEYS,
    );
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved?.role).toBe("smol");
  });
});

describe("context window gating", () => {
  const MIN = SUMMARY_RESERVE_TOKENS + MIN_VIABLE_BATCH_TOKENS;

  test("too-small window (< minContextWindow) advances the chain", async () => {
    const tinySmall = fakeModel({ id: "tiny-model", contextWindow: 6_000 });
    const h = harness({ "@tiny": tinySmall, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps, {
      minContextWindow: MIN,
    });
    expect(resolved?.role).toBe("smol");
    expect(resolved?.label).toBe("openai/smol-model");
    expect(h.resolveCalls).toEqual(["@tiny", "@smol"]);
  });

  test("window exactly at the minimum is eligible", async () => {
    const tinyExact = fakeModel({ id: "tiny-model", contextWindow: MIN });
    const h = harness({ "@tiny": tinyExact, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps, {
      minContextWindow: MIN,
    });
    expect(resolved?.role).toBe("tiny");
  });

  test("absent or non-finite window does not constrain and is omitted from info", async () => {
    const absentWindow: FakeModel = {
      id: "tiny-model",
      provider: "openai",
      input: ["text"],
    };
    const infiniteWindow = fakeModel({
      id: "tiny-model",
      contextWindow: Infinity,
    });
    const stringWindow = fakeModel({
      id: "tiny-model",
      contextWindow: "64000",
    });
    const zeroWindow = fakeModel({ id: "tiny-model", contextWindow: 0 });
    for (const candidate of [
      absentWindow,
      infiniteWindow,
      stringWindow,
      zeroWindow,
    ]) {
      const h = harness({ "@tiny": candidate, "@smol": SMOL }, KEYS);
      const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps, {
        minContextWindow: MIN,
      });
      expect(resolved?.role).toBe("tiny");
      expect(resolved?.model.contextWindow).toBeUndefined();
    }
  });

  test("small-but-sufficient context is reported and reduces the batch budget", async () => {
    const h = harness({ "@tiny": TINY, "@smol": SMOL }, KEYS);
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps, {
      minContextWindow: MIN,
    });
    expect(resolved?.role).toBe("tiny");
    expect(resolved?.model.contextWindow).toBe(32_000);
    expect(batchBudgetFor(48_000, resolved?.model.contextWindow)).toBe(24_000);
  });
});

describe("active tier", () => {
  test("no models facade: active model resolves when it has a key", async () => {
    const h = harness({}, KEYS);
    delete h.deps.models;
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps, {
      activeModel: ACTIVE,
    });
    expect(resolved?.role).toBe("active");
    expect(resolved?.model.id).toBe("active-model");
    expect(resolved?.label).toBe("anthropic/active-model");
    expect(resolved?.apiKey).toBe("key-active");
    expect(h.resolveCalls).toEqual([]);
    expect(h.keyCalls.map((call) => call.model)).toEqual([ACTIVE]);
  });

  test("no facade and no active model resolves nothing", async () => {
    const h = harness({}, KEYS);
    delete h.deps.models;
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps);
    expect(resolved).toBeUndefined();
  });

  test("active without a key advances to the next tier in the chain", async () => {
    const h = harness({ "@tiny": TINY }, { "tiny-model": "key-tiny" });
    const resolved = await resolveSummaryModel(["active", "tiny"], h.deps, {
      activeModel: ACTIVE,
    });
    expect(resolved?.role).toBe("tiny");
    expect(h.keyCalls.map((call) => call.model)).toEqual([ACTIVE, TINY]);
  });
});

describe("label derivation", () => {
  test("missing provider or id falls back to unknown", async () => {
    const noProvider = fakeModel({ id: "smol-model", provider: undefined });
    const noId = fakeModel({ provider: "openai", id: undefined });
    const neither: FakeModel = { input: ["text"], contextWindow: 64_000 };

    const h1 = harness({ "@tiny": noProvider }, KEYS, "key");
    const r1 = await resolveSummaryModel(TIER_CHAINS.leaf, h1.deps);
    expect(r1?.label).toBe("unknown/smol-model");

    const h2 = harness({ "@tiny": noId }, KEYS, "key");
    const r2 = await resolveSummaryModel(TIER_CHAINS.leaf, h2.deps);
    expect(r2?.label).toBe("openai/unknown");

    const h3 = harness({ "@tiny": neither }, KEYS, "key");
    const r3 = await resolveSummaryModel(TIER_CHAINS.leaf, h3.deps);
    expect(r3?.label).toBe("unknown/unknown");
  });
});

describe("getApiKey passthrough", () => {
  test("sessionId and signal reach getApiKey with the candidate model", async () => {
    const controller = new AbortController();
    const h = harness({ "@tiny": TINY, "@smol": SMOL }, KEYS);
    h.deps.sessionId = "sess-9";
    const resolved = await resolveSummaryModel(TIER_CHAINS.leaf, h.deps, {
      signal: controller.signal,
    });
    expect(resolved?.role).toBe("tiny");
    expect(h.keyCalls).toHaveLength(1);
    expect(h.keyCalls[0].model).toBe(TINY);
    expect(h.keyCalls[0].sessionId).toBe("sess-9");
    expect(h.keyCalls[0].options?.signal).toBe(controller.signal);
  });
});

describe("batchBudgetFor boundaries", () => {
  test("undefined or non-finite window returns the configured maximum", () => {
    expect(batchBudgetFor(48_000, undefined)).toBe(48_000);
    expect(batchBudgetFor(48_000, NaN)).toBe(48_000);
    expect(batchBudgetFor(48_000, Infinity)).toBe(48_000);
  });

  test("huge window is capped by the configured maximum", () => {
    expect(batchBudgetFor(48_000, 1_000_000)).toBe(48_000);
  });

  test("small-but-sufficient window reduces the budget by the reserve", () => {
    expect(batchBudgetFor(48_000, 20_000)).toBe(12_000); // default reserve 8_000
    expect(batchBudgetFor(48_000, 20_000, 8_000)).toBe(12_000);
    expect(batchBudgetFor(48_000, 20_000, 4_000)).toBe(16_000);
  });

  test("fractional windows are floored", () => {
    expect(batchBudgetFor(48_000, 20_000.7)).toBe(12_000);
    expect(batchBudgetFor(48_000, 20_001)).toBe(12_001);
  });

  test("window at or below the reserve floors at 1", () => {
    expect(batchBudgetFor(48_000, 8_000)).toBe(1);
    expect(batchBudgetFor(48_000, 5_000)).toBe(1);
    expect(batchBudgetFor(48_000, -5)).toBe(1);
  });

  test("configured maximum below the window-reserve wins", () => {
    expect(batchBudgetFor(10_000, 20_000)).toBe(10_000);
    expect(batchBudgetFor(0, 20_000)).toBe(1);
  });
});
