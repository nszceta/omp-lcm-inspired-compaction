import { describe, expect, test } from "bun:test";
import { LCM_PRESERVE_KEY } from "../src/contracts.ts";
import { renderContextFull } from "../src/render-context-full.ts";

describe("context-full renderer", () => {
  test("preserves boundaries and strips foreign preserve keys", () => {
    const state: any = {
      version: 1,
      generation: 3,
      roots: [
        {
          artifactId: "4",
          level: 0,
          summary: "kept",
          sourceEntryCount: 2,
          tokenCount: 3,
        },
      ],
    };
    const result = renderContextFull({
      preparation: { firstKeptEntryId: "keep", tokensBefore: 99 },
      state,
    });
    expect(result.firstKeptEntryId).toBe("keep");
    expect(result.tokensBefore).toBe(99);
    expect(result.summary).toContain("Expand node: artifact://4");
    expect(result.preserveData).toEqual({ [LCM_PRESERVE_KEY]: state });
  });
});
