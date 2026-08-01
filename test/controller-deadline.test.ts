import { describe, expect, test } from "bun:test";
import type { LcmConfig } from "../src/config.ts";
import { type CompletionCall, createController } from "../src/controller.ts";
import {
  artifactStore,
  entry,
  event,
  preparation,
  type SavedArtifact,
} from "./helpers.ts";

// Real wall-clock delays are deliberate here: the frozen contract requires the
// deadline regression to exercise the production Deadline timers (setTimeout)
// end to end, with no fake timers — a fake clock would not prove that the
// handler returns before the wall-clock deadline. Delays are short (tens of ms
// apart from the 900ms outliving batch) and every assertion is a hard
// contract (aborted calls reject, elapsed < 1400ms, fallback counts).

// One entry whose JSON serialization is exactly 48_000 chars (~12_000 tokens at
// chars/4). planRawChunks therefore emits one chunk per entry, and the 48_000
// token batch budget packs four chunks per batch: 22 chunks -> 6 batches.
const BATCH_INPUT_CHARS = 48_000;
const ENTRY_COUNT = 22;

function chunkEntry(id: string): Record<string, unknown> {
  const base = JSON.stringify({
    type: "message",
    id,
    message: { role: "user", content: "" },
  }).length;
  const content = "x".repeat(Math.max(0, BATCH_INPUT_CHARS - base));
  return { type: "message", id, message: { role: "user", content } };
}

function modelId(model: unknown): string | undefined {
  if (model && typeof model === "object" && "id" in model) {
    const id = model.id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

interface RecordedCompletion {
  modelId: string | undefined;
  input: string;
  startedAt: number;
  finishedAt: number;
  aborted: boolean;
}

/** Adversarial completion fake: real setTimeout delays, honors the signal
 *  (rejects on abort), records start/end, and tracks the active count. */
function completionRecorder(delayFor: (input: string) => number) {
  const requests: RecordedCompletion[] = [];
  let active = 0;
  let maxActive = 0;
  const complete: CompletionCall = async (model, context, options) => {
    const input = context.messages[0]?.content ?? "";
    active++;
    maxActive = Math.max(maxActive, active);
    const record: RecordedCompletion = {
      modelId: modelId(model),
      input,
      startedAt: Date.now(),
      finishedAt: 0,
      aborted: false,
    };
    requests.push(record);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          options.signal.removeEventListener("abort", onAbort);
          resolve();
        }, delayFor(input));
        const onAbort = () => {
          clearTimeout(timer);
          record.aborted = true;
          reject(
            options.signal.reason ??
              new DOMException("The operation was aborted", "AbortError"),
          );
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      active--;
      record.finishedAt = Date.now();
    }
    return "consolidated model summary of the archived source";
  };
  return {
    complete,
    requests,
    maxActive: () => maxActive,
  };
}

/** Fake ctx: models.resolve provides @tiny/@smol tier models with keys. */
function tieredContext() {
  const store = artifactStore();
  const resolveCalls: string[] = [];
  const ctx: Record<string, unknown> = {
    cwd: "/tmp",
    model: {
      id: "active-model",
      provider: "active-provider",
      input: ["text"],
    },
    sessionManager: store,
    modelRegistry: {
      getApiKey: async (model: unknown) => {
        if (modelId(model) === "active-model") return "active-key";
        return `key-${modelId(model) ?? "unknown"}`;
      },
    },
    models: {
      resolve: (spec: string) => {
        resolveCalls.push(spec);
        if (spec === "@tiny") {
          return {
            provider: "fake",
            id: "tiny",
            input: ["text"],
            contextWindow: 128_000,
          };
        }
        if (spec === "@smol") {
          return { provider: "fake", id: "smol", input: ["text"] };
        }
        return undefined;
      },
    },
  };
  return { ctx, store, resolveCalls };
}

const DEADLINE_CONFIG: Partial<LcmConfig> = {
  handlerDeadlineMs: 1400,
  summaryConcurrency: 4,
  summaryBatchInputTokens: 48000,
  leafSummaryModel: "tiny",
  rootSummaryModel: "smol",
};

const FAST_CONFIG: Partial<LcmConfig> = {
  handlerDeadlineMs: 10000,
  summaryConcurrency: 4,
  summaryBatchInputTokens: 48000,
  leafSummaryModel: "tiny",
  rootSummaryModel: "smol",
};

const slowLeafDelays = (input: string): number => {
  if (input.startsWith("Root ")) return 50;
  if (input.includes('"id":"e0"')) return 900; // batch 0: outlives the 816ms leaf stage
  if (input.includes('"id":"e16"')) return 900; // batch 4: outlives the leaf stage
  if (input.includes('"id":"e20"')) return 900; // batch 5: outlives the leaf stage
  if (input.includes('"id":"e4"')) return 80; // batch 1
  if (input.includes('"id":"e8"')) return 40; // batch 2 (finishes before batch 1)
  if (input.includes('"id":"e12"')) return 60; // batch 3
  return 50;
};

function leafNodes(store: { saved: SavedArtifact[] }) {
  return store.saved
    .filter((saved) => saved.toolType === "lcm-node")
    .map((saved) => JSON.parse(saved.content))
    .filter((node) => node.kind === "leaf-summary");
}

/** Walk the saved node artifacts from the returned roots (children -> node,
 *  rawSources -> raw ids) and return every reachable raw artifact id sorted. */
function reachableRawIds(
  store: { saved: SavedArtifact[] },
  state: { roots: Array<{ artifactId: string }> },
): string[] {
  const nodesById = new Map(
    store.saved
      .filter((saved) => saved.toolType === "lcm-node")
      .map((saved) => [saved.id, JSON.parse(saved.content)]),
  );
  const reachable = new Set<string>();
  const visit = (artifactId: string) => {
    const node = nodesById.get(artifactId);
    expect(node).toBeDefined();
    for (const raw of node?.rawSources ?? []) reachable.add(String(raw));
    for (const child of node?.children ?? []) visit(String(child));
  };
  for (const root of state.roots) visit(root.artifactId);
  return [...reachable].sort((a, b) => Number(a) - Number(b));
}

describe("controller deadlines and tiers", () => {
  test("consolidates 22 chunks into 6 bounded parallel batches and falls back before the deadline", async () => {
    const { ctx, store } = tieredContext();
    const recorder = completionRecorder(slowLeafDelays);
    const controller = createController(ctx, {
      complete: recorder.complete,
      config: { ...DEADLINE_CONFIG },
    });
    const entries = Array.from({ length: ENTRY_COUNT }, (_, index) =>
      chunkEntry(`e${index}`),
    );
    const startedAt = Date.now();
    const result = await controller.beforeCompact(
      event(preparation("keep"), [...entries, entry("keep")]),
    );
    const elapsed = Date.now() - startedAt;
    expect(result.compaction).toBeDefined();
    expect(result.cancel).toBeUndefined();
    expect(elapsed).toBeLessThan(1400);

    // One model completion per batch (6), never one per chunk (22).
    const leafRequests = recorder.requests.filter(
      (request) => !request.input.startsWith("Root "),
    );
    expect(leafRequests).toHaveLength(6);
    expect(recorder.maxActive()).toBeLessThanOrEqual(4);

    // Batch 2 finishes before batch 1 despite a later index (reversed order).
    const finishedAt = (marker: string) => {
      const request = leafRequests.find((item) => item.input.includes(marker));
      expect(request).toBeDefined();
      return request?.finishedAt ?? 0;
    };
    expect(finishedAt('"id":"e8"')).toBeLessThan(finishedAt('"id":"e4"'));
    expect(finishedAt('"id":"e8"')).toBeLessThan(finishedAt('"id":"e0"'));

    // The three batches that outlived the leaf stage were aborted and fell
    // back to deterministic summaries; the rest were model-summarized.
    expect(leafRequests.filter((request) => request.aborted)).toHaveLength(3);
    const nodes = leafNodes(store);
    expect(
      nodes.filter((node) => node.summary.includes("deterministic fallback")),
    ).toHaveLength(3);

    // Deferred writes interleave raw ids with node ids; leaves preserve chunk
    // order, so each leaf references exactly the raws written before it.
    const rawArtifacts = store.saved
      .filter((artifact) => artifact.toolType === "lcm-raw")
      .map((artifact) => artifact.id);
    expect(nodes.flatMap((node) => node.rawSources)).toEqual(rawArtifacts);

    // Every raw artifact id is reachable from the returned roots, exactly once.
    const state = result.compaction.preserveData.ompLcmArtifactsV1;
    expect(reachableRawIds(store, state)).toEqual(
      [...rawArtifacts].sort((a, b) => Number(a) - Number(b)),
    );

    expect(controller.status.lastOutcome).toBe("success");
    expect(controller.status.lastRawChunkCount).toBe(22);
    expect(controller.status.lastSummaryBatchCount).toBe(6);
    expect(controller.status.lastSummaryConcurrency).toBe(4);
    expect(controller.status.lastCompletedModelSummaryCount).toBe(3);
    expect(
      controller.status.lastDeadlineFallbackCount ?? 0,
    ).toBeGreaterThanOrEqual(1);
    expect(controller.status.lastDeadlineStage).toBe("leaf");
    expect(controller.status.lastLeafSummaryModel).toBe("fake/tiny");
    expect(controller.status.lastSummaryQuality).toBe("deterministic-fallback");
  });

  test("happy path summarizes every batch through tier models without fallback", async () => {
    const { ctx, store } = tieredContext();
    const recorder = completionRecorder(() => 20);
    const controller = createController(ctx, {
      complete: recorder.complete,
      config: { ...FAST_CONFIG },
    });
    const entries = Array.from({ length: ENTRY_COUNT }, (_, index) =>
      chunkEntry(`e${index}`),
    );
    const result = await controller.beforeCompact(
      event(preparation("keep"), [...entries, entry("keep")]),
    );
    expect(result.compaction).toBeDefined();
    expect(controller.status.lastOutcome).toBe("success");
    expect(controller.status.lastSummaryBatchCount).toBe(6);
    expect(controller.status.lastCompletedModelSummaryCount).toBe(6);
    expect(controller.status.lastSummaryQuality).toBe("model");
    expect(controller.status.lastDeadlineFallbackCount).toBe(0);
    expect(controller.status.lastDeterministicFallbackCount).toBe(0);
    expect(controller.status.lastLeafSummaryModel).toBe("fake/tiny");
    expect(controller.status.lastRootSummaryModel).toBe("fake/smol");
    expect(typeof controller.status.lastStartedAt).toBe("string");
    expect(typeof controller.status.lastElapsedMs).toBe("number");
    expect(controller.status.lastRootCount ?? 0).toBeLessThanOrEqual(4);
    const state = result.compaction.preserveData.ompLcmArtifactsV1;
    const rawArtifacts = store.saved
      .filter((artifact) => artifact.toolType === "lcm-raw")
      .map((artifact) => artifact.id);
    expect(reachableRawIds(store, state)).toEqual(
      [...rawArtifacts].sort((a, b) => Number(a) - Number(b)),
    );
  });

  test("skips provider-native replay when the total deadline reserve is exhausted", async () => {
    const store = artifactStore();
    const ctx: Record<string, unknown> = {
      cwd: "/tmp",
      model: {
        id: "gpt-replay",
        provider: "openai",
        api: "openai-responses",
        input: ["text"],
        contextWindow: 128_000,
      },
      sessionManager: store,
      modelRegistry: { getApiKey: async () => "provider-key" },
    };
    let replayCalls = 0;
    const recorder = completionRecorder((input) =>
      input.startsWith("Root ") ? 1500 : 200,
    );
    const controller = createController(ctx, {
      complete: recorder.complete,
      requestNativeCompaction: async () => {
        replayCalls++;
        return {
          provider: "openai",
          replacementHistory: [
            { type: "compaction", encrypted_content: "cipher" },
          ],
          compactionItem: {
            type: "compaction",
            encrypted_content: "cipher",
          },
        };
      },
      config: { ...DEADLINE_CONFIG },
    });
    const entries = Array.from({ length: ENTRY_COUNT }, (_, index) =>
      chunkEntry(`e${index}`),
    );
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [
            { role: "user", content: "discarded turn", timestamp: 1 },
          ],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [...entries, entry("keep")],
      ),
    );
    expect(replayCalls).toBe(0);
    expect(result.compaction).toBeDefined();
    expect(result.compaction.preserveData.ompLcmArtifactsV1).toBeDefined();
    expect(controller.status.lastNativeReplayStatus).toBe("failed");
    expect(controller.status.lastNativeReplayError).toContain(
      "internal deadline reached",
    );
    // Root condensation now aborts at the internal deadline (it previously ran
    // past it), so the first deadline-affected stage is "root"; the native
    // replay skip is downstream of the same expiry. If root calls ever stop
    // honoring the deadline again, this assertion fails.
    expect(controller.status.lastDeadlineStage).toBe("root");
  });

  test("runs provider-native replay when the deadline reserve is intact", async () => {
    const store = artifactStore();
    const ctx: Record<string, unknown> = {
      cwd: "/tmp",
      model: {
        id: "gpt-replay",
        provider: "openai",
        api: "openai-responses",
        input: ["text"],
        contextWindow: 128_000,
      },
      sessionManager: store,
      modelRegistry: { getApiKey: async () => "provider-key" },
    };
    let replayCalls = 0;
    const recorder = completionRecorder(() => 20);
    const controller = createController(ctx, {
      complete: recorder.complete,
      requestNativeCompaction: async () => {
        replayCalls++;
        return {
          provider: "openai",
          replacementHistory: [
            { type: "compaction", encrypted_content: "cipher" },
          ],
          compactionItem: {
            type: "compaction",
            encrypted_content: "cipher",
          },
        };
      },
      config: { ...FAST_CONFIG },
    });
    const entries = Array.from({ length: ENTRY_COUNT }, (_, index) =>
      chunkEntry(`e${index}`),
    );
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [
            { role: "user", content: "discarded turn", timestamp: 1 },
          ],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [...entries, entry("keep")],
      ),
    );
    expect(replayCalls).toBe(1);
    expect(result.compaction).toBeDefined();
    expect(result.compaction.preserveData.ompLcmArtifactsV1).toBeDefined();
    expect(result.compaction.preserveData.openaiRemoteCompaction).toBeDefined();
    expect(controller.status.lastNativeReplayStatus).toBe("preserved");
    expect(controller.status.lastDeadlineStage).toBeUndefined();
  });

  test("falls back to the next tier when the preferred tier has no credentials", async () => {
    const { ctx } = tieredContext();
    const recorder = completionRecorder(() => 10);
    ctx.modelRegistry = {
      getApiKey: async (model: unknown) =>
        modelId(model) === "smol" || modelId(model) === "active-model"
          ? "key"
          : undefined,
    };
    const controller = createController(ctx, {
      complete: recorder.complete,
      config: { ...FAST_CONFIG, summaryConcurrency: 2 },
    });
    const result = await controller.beforeCompact(
      event(preparation("keep"), [
        entry("old", "small archived source"),
        entry("keep"),
      ]),
    );
    expect(result.compaction).toBeDefined();
    expect(controller.status.lastOutcome).toBe("success");
    expect(controller.status.lastLeafSummaryModel).toBe("fake/smol");
    expect(controller.status.lastCompletedModelSummaryCount).toBe(1);
    expect(recorder.requests[0]?.modelId).toBe("smol");
  });

  test("falls back to the next tier when the preferred tier's context window is too small", async () => {
    const { ctx } = tieredContext();
    const recorder = completionRecorder(() => 10);
    ctx.models = {
      resolve: (spec: string) => {
        if (spec === "@tiny") {
          return {
            provider: "fake",
            id: "tiny",
            input: ["text"],
            contextWindow: 6_000, // below the 10_048 token minimum
          };
        }
        if (spec === "@smol") {
          return { provider: "fake", id: "smol", input: ["text"] };
        }
        return undefined;
      },
    };
    ctx.modelRegistry = { getApiKey: async () => "key" };
    const controller = createController(ctx, {
      complete: recorder.complete,
      config: { ...FAST_CONFIG, summaryConcurrency: 2 },
    });
    const result = await controller.beforeCompact(
      event(preparation("keep"), [
        entry("old", "small archived source"),
        entry("keep"),
      ]),
    );
    expect(result.compaction).toBeDefined();
    expect(controller.status.lastLeafSummaryModel).toBe("fake/smol");
    expect(recorder.requests[0]?.modelId).toBe("smol");
  });

  test("resets deadline status fields at hook entry of every run", async () => {
    const { ctx } = tieredContext();
    let slow = true;
    const recorder = completionRecorder((input) => {
      if (!slow) return 10;
      if (input.startsWith("Root ")) return 50;
      return input.includes('"id":"e0"') ? 900 : 50;
    });
    const config = { ...DEADLINE_CONFIG };
    const controller = createController(ctx, {
      complete: recorder.complete,
      config,
    });
    const entries = Array.from({ length: 6 }, (_, index) =>
      chunkEntry(`e${index}`),
    );

    // Run 1: a success that hit the leaf deadline.
    const first = await controller.beforeCompact(
      event(preparation("keep"), [...entries, entry("keep")]),
    );
    expect(first.compaction).toBeDefined();
    expect(controller.status.lastOutcome).toBe("success");
    expect(
      controller.status.lastDeadlineFallbackCount ?? 0,
    ).toBeGreaterThanOrEqual(1);
    expect(controller.status.lastDeadlineStage).toBe("leaf");

    // Run 2: pre-aborted event; the deadline fields were cleared at entry.
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await controller.beforeCompact(
      event(preparation("keep"), [entry("old"), entry("keep")], {
        signal: aborted.signal,
      }),
    );
    expect(cancelled).toEqual({ cancel: true });
    expect(controller.status.lastOutcome).toBe("cancelled");
    expect(controller.status.lastDeadlineStage).toBeUndefined();
    expect(controller.status.lastDeadlineFallbackCount).toBeUndefined();

    // Run 3: a clean success; the fields reflect the new run, not run 1.
    slow = false;
    config.handlerDeadlineMs = 10000;
    const second = await controller.beforeCompact(
      event(preparation("keep"), [...entries, entry("keep")]),
    );
    expect(second.compaction).toBeDefined();
    expect(controller.status.lastOutcome).toBe("success");
    expect(controller.status.lastDeadlineFallbackCount).toBe(0);
    expect(controller.status.lastDeadlineStage).toBeUndefined();
    expect(controller.status.lastSummaryQuality).toBe("model");
  });

  test("honors configured leaf and root tier preferences in the fallback chains", async () => {
    const { ctx, resolveCalls } = tieredContext();
    const recorder = completionRecorder(() => 5);
    const controller = createController(ctx, {
      complete: recorder.complete,
      config: {
        ...FAST_CONFIG,
        leafSummaryModel: "smol",
        rootSummaryModel: "tiny",
        // One 12K-token chunk per batch: 6 batches -> 6 leaves -> condensation.
        summaryBatchInputTokens: 12_000,
      },
    });
    const entries = Array.from({ length: 6 }, (_, index) =>
      chunkEntry(`e${index}`),
    );
    const result = await controller.beforeCompact(
      event(preparation("keep"), [...entries, entry("keep")]),
    );
    expect(result.compaction).toBeDefined();
    // Leaf chain starts at the configured "smol" preference, not the default tiny.
    expect(resolveCalls[0]).toBe("@smol");
    // Root chain starts at the configured "tiny" preference, not the default smol.
    expect(resolveCalls).toContain("@tiny");
    expect(resolveCalls.indexOf("@tiny")).toBeGreaterThan(
      resolveCalls.indexOf("@smol"),
    );
    expect(controller.status.lastLeafSummaryModel).toBe("fake/smol");
    expect(controller.status.lastRootSummaryModel).toBe("fake/tiny");
    // Leaf calls ran on the smol model; the root condensation ran on tiny.
    const leafRequests = recorder.requests.filter(
      (request) => !request.input.startsWith("Root "),
    );
    const rootRequests = recorder.requests.filter((request) =>
      request.input.startsWith("Root "),
    );
    expect(leafRequests.length).toBe(6);
    expect(leafRequests.every((request) => request.modelId === "smol")).toBe(
      true,
    );
    expect(rootRequests.length).toBeGreaterThan(0);
    expect(rootRequests.every((request) => request.modelId === "tiny")).toBe(
      true,
    );
  });
});
