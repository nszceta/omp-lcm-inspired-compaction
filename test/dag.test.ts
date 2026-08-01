import { describe, expect, test } from "bun:test";
import { buildDag } from "../src/dag.ts";
import { artifactStore } from "./helpers.ts";

describe("immutable DAG", () => {
  test("writes leaves and condenses bounded roots", async () => {
    const store = artifactStore();
    const result = await buildDag({
      store,
      generation: 1,
      leaves: Array.from({ length: 6 }, (_, i) => ({
        summary: `s${i}`,
        rawArtifactIds: [String(i + 100)],
        sourceEntryIds: [`e${i}`],
      })),
    });
    expect(result.roots.length).toBeLessThanOrEqual(4);
    expect(store.saved.every((x) => x.toolType === "lcm-node")).toBe(true);
    expect(result.state.generation).toBe(1);
  });
  test("bounds a condensed parent without singleton rewrapping", async () => {
    const store = artifactStore();
    const result = await buildDag({
      store,
      generation: 2,
      priorRoots: [
        {
          artifactId: "100",
          level: 3,
          summary: "a".repeat(5_000),
          sourceEntryCount: 10,
          tokenCount: 1_250,
        },
        {
          artifactId: "101",
          level: 4,
          summary: "b".repeat(5_000),
          sourceEntryCount: 20,
          tokenCount: 1_250,
        },
      ],
      summarize: async (input) => input,
    });
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]?.level).toBe(5);
    expect(result.roots[0]?.tokenCount).toBeLessThanOrEqual(2_040);
    expect(store.saved).toHaveLength(1);
    const node = JSON.parse(store.saved[0]?.content ?? "{}");
    expect(node.children).toEqual(["100", "101"]);
    expect(node.summary).not.toContain("Archived LCM history:");
    const next = await buildDag({
      store,
      generation: 3,
      priorRoots: result.roots,
      leaves: [
        {
          summary: "new leaf",
          rawArtifactIds: ["200"],
          sourceEntryIds: ["new-entry"],
        },
      ],
      summarize: async (input) => input,
    });
    expect(next.roots).toHaveLength(1);
    expect(next.roots[0]?.level).toBe(6);
    expect(next.roots[0]?.tokenCount).toBeLessThanOrEqual(2_040);
    expect(next.roots[0]?.summary).not.toContain("Archived LCM history:");
  });
  test("repairs a degraded prior root exactly once", async () => {
    const store = artifactStore();
    const result = await buildDag({
      store,
      generation: 3,
      priorRoots: [
        {
          artifactId: "86",
          level: 9,
          summary:
            "Archived LCM history: Archived source (deterministic fallback): raw",
          sourceEntryCount: 185,
          tokenCount: 20,
        },
      ],
      repairRoot: async () => "repaired semantic summary",
      summarize: async () => "repaired semantic summary",
    });
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]?.level).toBe(10);
    expect(result.roots[0]?.summary).toBe("repaired semantic summary");
    expect(store.saved).toHaveLength(1);
    expect(JSON.parse(store.saved[0]?.content ?? "{}").children).toEqual([
      "86",
    ]);
  });
  test("keeps a degraded root unchanged when repair cannot converge", async () => {
    const store = artifactStore();
    const result = await buildDag({
      store,
      generation: 3,
      priorRoots: [
        {
          artifactId: "86",
          level: 9,
          summary:
            "Archived LCM history: Archived source (deterministic fallback): raw",
          sourceEntryCount: 185,
          tokenCount: 20,
        },
      ],
      repairRoot: async () => undefined,
      summarize: async () => "unused",
    });
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]?.artifactId).toBe("86");
    expect(result.roots[0]?.level).toBe(9);
    expect(store.saved).toHaveLength(0);
  });
  test("builds a DAG from zero-based raw artifact ids", async () => {
    const store = artifactStore(0);
    const result = await buildDag({
      store,
      generation: 1,
      leaves: [
        { summary: "s0", rawArtifactIds: ["0"], sourceEntryIds: ["e0"] },
      ],
    });
    expect(result.roots).toHaveLength(1);
    // No raw write happens (rawArtifactIds supplied), so the leaf node is the
    // first save and gets the store's zero-based id "0".
    expect(result.roots[0]?.artifactId).toBe("0");
    expect(store.saved).toHaveLength(1);
    const node = JSON.parse(store.saved[0]?.content ?? "{}");
    expect(node.rawSources).toEqual(["0"]);
  });
  test("failed IDs cannot become roots", async () => {
    const store = { saveArtifact: () => "bad" };
    await expect(
      buildDag({
        store,
        generation: 1,
        leaves: [
          { summary: "x", rawArtifactIds: ["1"], sourceEntryIds: ["e"] },
        ],
      }),
    ).rejects.toThrow();
  });
});
