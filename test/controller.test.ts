import { describe, expect, test } from "bun:test";
import { type CompletionCall, createController } from "../src/controller.ts";
import {
  artifactStore,
  entry,
  event,
  expectCancel,
  preparation,
} from "./helpers.ts";

describe("controller", () => {
  function ctx(model: any = { input: ["text"] }) {
    return {
      cwd: "/tmp",
      model,
      sessionManager: artifactStore(),
      modelRegistry: { getApiKey: async () => "key" },
    };
  }
  test("returns complete context-full result and status", async () => {
    const c = ctx();
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    const result = await controller.beforeCompact(
      event(preparation("keep", { messagesToSummarize: ["discarded"] }), [
        entry("old"),
        entry("keep"),
      ]),
    );
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("keep");
    expect(controller.status.lastOutcome).toBe("success");
    expect(controller.status.lastRootCount).toBe(1);
    expect(controller.status.lastRoots).toHaveLength(1);
    expect(controller.status.lastRawArtifactCount).toBe(1);
    expect(controller.status.lastSourceEntryCount).toBe(1);
    expect(controller.status.lastSummaryPreview).toContain(
      "Retained LCM history",
    );
    expect(controller.status.builtInRemoteContextFullIntercepted).toBe(false);
    expect(controller.status.lastSummaryQuality).toBe("model");
    expect(controller.status.lastDeterministicFallbackCount).toBe(0);
  });
  test("uses pi-ai context and extracts assistant text blocks", async () => {
    const c = ctx();
    let completionContext: Parameters<CompletionCall>[1] | undefined;
    const controller = createController(c, {
      complete: async (_model, context) => {
        completionContext = context;
        return {
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "concise model summary" },
          ],
        };
      },
    });
    await controller.beforeCompact(
      event(preparation("keep"), [
        entry("old", "source detail ".repeat(200)),
        entry("keep"),
      ]),
    );
    expect(completionContext?.systemPrompt[0]).toContain(
      "Summarize the source faithfully",
    );
    expect(completionContext?.messages).toHaveLength(1);
    expect(completionContext?.messages[0]?.role).toBe("user");
    expect(completionContext?.messages[0]?.content).toContain("source detail");
    const node = c.sessionManager.saved.find(
      (artifact) => artifact.toolType === "lcm-node",
    );
    expect(node).toBeDefined();
    expect(JSON.parse(node?.content ?? "{}").summary).toBe(
      "concise model summary",
    );
    expect(controller.status.lastSummaryQuality).toBe("model");
  });
  test("uses model summarization when condensing prior roots", async () => {
    const c = ctx();
    const controller = createController(c, {
      summaryCall: async (request) =>
        request.prompt.includes("LCM root condensation")
          ? "model-condensed parent"
          : "model leaf summary",
    });
    const priorRoots = Array.from({ length: 4 }, (_, index) => ({
      artifactId: String(100 + index),
      level: 0,
      summary: `prior root ${index}`,
      sourceEntryCount: 10,
      tokenCount: 4,
    }));
    await controller.beforeCompact(
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
        [entry("old", "new source ".repeat(100)), entry("keep")],
      ),
    );
    const condensed = c.sessionManager.saved
      .filter((artifact) => artifact.toolType === "lcm-node")
      .map((artifact) => JSON.parse(artifact.content))
      .find((node) => node.kind === "condensed-summary");
    expect(condensed?.summary).toBe("model-condensed parent");
    expect(condensed?.level).toBe(1);
    expect(controller.status.lastSummaryQuality).toBe("model");
    expect(controller.status.lastDeterministicFallbackCount).toBe(0);
  });
  test("reports and bounds deterministic fallback", async () => {
    const c = ctx();
    const controller = createController(c, {
      summaryCall: async () => {
        throw new Error("model unavailable");
      },
    });
    await controller.beforeCompact(
      event(preparation("keep"), [
        entry("old", `opaque-${"x".repeat(20_000)}`),
        entry("keep"),
      ]),
    );
    expect(controller.status.lastSummaryQuality).toBe("deterministic-fallback");
    expect(controller.status.lastDeterministicFallbackCount).toBe(1);
    const node = c.sessionManager.saved.find(
      (artifact) => artifact.toolType === "lcm-node",
    );
    const summary = String(JSON.parse(node?.content ?? "{}").summary ?? "");
    expect(summary).toContain("deterministic fallback");
    expect(Math.ceil(summary.length / 4)).toBeLessThanOrEqual(2_048);
    expect(summary).not.toContain("x".repeat(20_000));
  });
  test("fails closed on boundary and abort", async () => {
    const c = ctx();
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    expectCancel(
      await controller.beforeCompact(
        event(preparation("missing"), [entry("a")]),
      ),
    );
    const ac = new AbortController();
    ac.abort();
    expectCancel(
      await controller.beforeCompact(
        event(preparation("a"), [entry("a")], { signal: ac.signal }),
      ),
    );
  });
  test("selects snapcompact for vision model", async () => {
    const c = ctx({ input: ["text", "image"] });
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    const result = await controller.beforeCompact(
      event(preparation("keep", { settings: { strategy: "snapcompact" } }), [
        entry("old"),
        entry("keep"),
      ]),
    );
    expect(result).not.toBeUndefined();
  });
  test("accepts zero-based artifact ids from a real OMP session store", async () => {
    // Real OMP artifact stores are 0-indexed (first artifact id "0").
    const c = ctx();
    c.sessionManager = artifactStore(0);
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    const result = await controller.beforeCompact(
      event(preparation("keep", { messagesToSummarize: ["discarded"] }), [
        entry("old"),
        entry("keep"),
      ]),
    );
    expect(result.compaction).toBeDefined();
    expect(controller.status.lastOutcome).toBe("success");
    const raw = c.sessionManager.saved.find(
      (artifact) => artifact.toolType === "lcm-raw",
    );
    const node = c.sessionManager.saved.find(
      (artifact) => artifact.toolType === "lcm-node",
    );
    expect(raw?.id).toBe("0");
    expect(node?.id).toBe("1");
    expect(JSON.parse(node?.content ?? "{}").rawSources).toEqual(["0"]);
  });
  test("mid-run abort before the first node write leaves zero artifacts", async () => {
    const c = ctx();
    const ac = new AbortController();
    const controller = createController(c, {
      summaryCall: async () => {
        ac.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    });
    expectCancel(
      await controller.beforeCompact(
        event(
          preparation("keep", { messagesToSummarize: ["discarded"] }),
          [entry("old"), entry("keep")],
          { signal: ac.signal },
        ),
      ),
    );
    expect(c.sessionManager.saved).toEqual([]);
  });
  test("failed run reports the orphan artifact count from prior roots", async () => {
    const c = ctx();
    const store = c.sessionManager;
    store.saved.push(
      {
        id: "1",
        toolType: "lcm-node",
        content: JSON.stringify({
          schema: "omp-lcm-node/v1",
          kind: "leaf-summary",
          level: 0,
          summary: "s",
          children: [],
          rawSources: ["2"],
          sourceEntryIds: ["keep"],
          sourceEntryCount: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      },
      { id: "2", toolType: "lcm-raw", content: "linked raw source" },
      { id: "3", toolType: "lcm-raw", content: "orphaned raw source" },
    );
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    expectCancel(
      await controller.beforeCompact(
        event(
          preparation("missing", {
            previousPreserveData: {
              ompLcmArtifactsV1: {
                version: 1,
                generation: 1,
                roots: [
                  {
                    artifactId: "1",
                    level: 0,
                    summary: "s",
                    sourceEntryCount: 1,
                    tokenCount: 1,
                  },
                ],
              },
            },
          }),
          [entry("a")],
        ),
      ),
    );
    expect(controller.status.lastError).toContain("keep boundary");
    expect(controller.status.lastOrphanArtifactCount).toBe(1);
  });
  test("success run on a store without listFiles leaves the orphan count undefined", async () => {
    const full = artifactStore();
    const controller = createController(
      {
        cwd: "/tmp",
        model: { input: ["text"] },
        sessionManager: {
          saveArtifact: (content: string, toolType: string) =>
            full.saveArtifact(content, toolType),
        },
        modelRegistry: { getApiKey: async () => "key" },
      },
      { summaryCall: async () => "summary" },
    );
    const result = await controller.beforeCompact(
      event(preparation("keep", { messagesToSummarize: ["discarded"] }), [
        entry("old"),
        entry("keep"),
      ]),
    );
    expect(result.compaction).toBeDefined();
    expect(controller.status.lastOutcome).toBe("success");
    expect(controller.status.lastOrphanArtifactCount).toBeUndefined();
    expect(full.saved.map((artifact) => artifact.toolType)).toEqual([
      "lcm-raw",
      "lcm-node",
    ]);
  });
  test("success run reports zero orphans on an empty store", async () => {
    const c = ctx();
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    const result = await controller.beforeCompact(
      event(preparation("keep", { messagesToSummarize: ["discarded"] }), [
        entry("old"),
        entry("keep"),
      ]),
    );
    expect(result.compaction).toBeDefined();
    expect(controller.status.lastOutcome).toBe("success");
    expect(controller.status.lastOrphanArtifactCount).toBe(0);
  });
});
