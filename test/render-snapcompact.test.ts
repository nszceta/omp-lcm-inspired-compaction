import { describe, expect, test } from "bun:test";
import { LCM_PRESERVE_KEY } from "../src/contracts.ts";
import {
  NonVisionModelError,
  renderSnapcompact,
} from "../src/render-snapcompact.ts";

describe("snapcompact renderer", () => {
  const state: any = {
    version: 1,
    generation: 2,
    roots: [
      {
        artifactId: "9",
        level: 0,
        summary: "root",
        sourceEntryCount: 1,
        tokenCount: 2,
      },
    ],
  };
  test("rejects text-only models before compact", async () => {
    let called = false;
    await expect(
      renderSnapcompact({
        preparation: { firstKeptEntryId: "k", tokensBefore: 1 },
        state,
        model: {},
        compact: async () => {
          called = true;
          return {};
        },
      }),
    ).rejects.toBeInstanceOf(NonVisionModelError);
    expect(called).toBe(false);
  });
  test("passes synthetic roots and bounded frames", async () => {
    let args: any[] = [];
    const result = await renderSnapcompact({
      preparation: { firstKeptEntryId: "k", tokensBefore: 1 },
      state,
      model: { input: ["text", "image"] },
      compact: async (...a) => {
        args = a;
        return { preserveData: { archive: "new" } };
      },
    });
    expect(args[2].maxFrames).toBe(4);
    expect(JSON.stringify(args[0])).toContain("artifact://9");
    expect(JSON.stringify(args[0])).not.toContain("old-raw");
    expect(result.preserveData[LCM_PRESERVE_KEY]).toEqual(state);
    expect(result.preserveData.archive).toBeUndefined();
  });
});
