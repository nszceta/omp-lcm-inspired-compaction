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
