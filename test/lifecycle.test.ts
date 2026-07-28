import { describe, expect, test } from "bun:test";
import { buildDag } from "../src/dag.ts";
import { renderContextFull } from "../src/render-context-full.ts";
import { artifactStore } from "./helpers.ts";

describe("lifecycle persistence", () => {
  test("repeated generations retain bounded roots and monotonic artifacts", async () => {
    const store = artifactStore();
    let prior: any[] = [];
    for (let generation = 1; generation <= 6; generation++) {
      const result = await buildDag({
        store,
        generation,
        priorRoots: prior,
        leaves: [
          {
            summary: `generation-${generation}`,
            rawArtifactIds: [String(100 + generation)],
            sourceEntryIds: [`entry-${generation}`],
          },
        ],
      });
      prior = result.roots;
      expect(prior.length).toBeLessThanOrEqual(4);
    }
    const state = { version: 1 as const, generation: 6, roots: prior };
    const rendered = renderContextFull({
      preparation: { firstKeptEntryId: "k", tokensBefore: 1 },
      state,
    });
    expect(rendered.summary).toContain("artifact://");
    expect(store.saved.length).toBeGreaterThan(6);
  });
});
