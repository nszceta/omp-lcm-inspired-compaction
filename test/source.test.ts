import { describe, expect, test } from "bun:test";
import { LCM_PRESERVE_KEY } from "../src/contracts.ts";
import {
  captureRawSource,
  planRawChunks,
  SourceAbortError,
  SourceBoundaryError,
  selectSourceEntries,
} from "../src/source.ts";
import { entry, event, jsonLines, preparation } from "./helpers.ts";

describe("source selection", () => {
  test("captures exact first-activation entries and stable chunks", async () => {
    const entries = [entry("a", "A"), entry("b", "B"), entry("keep", "K")];
    const result = await captureRawSource(
      event(preparation("keep"), entries),
      async (content) => {
        expect(content).toBe(
          `${JSON.stringify(entries[0])}\n${JSON.stringify(entries[1])}\n`,
        );
        return "1";
      },
      { targetTokens: 100 },
    );
    expect(result.selection.entries).toEqual(entries.slice(0, 2));
    expect(result.rawArtifactIds).toEqual(["1"]);
    expect(result.chunks[0].content).toBe(
      `${jsonLines(entries.slice(0, 2))}\n`,
    );
  });
  test("resumes after matching LCM compaction and excludes recent", () => {
    const state = { version: 1, generation: 4, roots: [] };
    const entries = [
      entry("old"),
      {
        type: "compaction",
        id: "c",
        preserveData: { [LCM_PRESERVE_KEY]: state },
      },
      entry("new"),
      entry("keep"),
    ];
    const s = selectSourceEntries(
      event(
        preparation("keep", {
          previousPreserveData: { [LCM_PRESERVE_KEY]: state },
        }),
        entries,
      ),
    );
    expect(s.entries.map((x) => x.id)).toEqual(["new"]);
  });
  test("rejects missing boundary and abort", () => {
    expect(() =>
      selectSourceEntries(event(preparation("missing"), [entry("a")])),
    ).toThrow(SourceBoundaryError);
    const c = new AbortController();
    c.abort();
    expect(() =>
      selectSourceEntries(
        event(preparation("a"), [entry("a")], { signal: c.signal }),
      ),
    ).toThrow(SourceAbortError);
  });
  test("never splits entries across deterministic chunks", () => {
    const chunks = planRawChunks([entry("a", "1234"), entry("b", "5678")], {
      targetTokens: 1,
      estimateTokens: () => 1,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].entries[0].id).toBe("a");
  });
});
