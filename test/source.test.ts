import { describe, expect, test } from "bun:test";
import { LCM_PRESERVE_KEY } from "../src/contracts.ts";
import {
  captureRawSource,
  planRawChunks,
  SourceAbortError,
  SourceBoundaryError,
  selectSourceEntries,
  serializeSummaryEntries,
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
  test("deferred capture writes no artifacts; eager capture writes every chunk", async () => {
    const entries = [
      entry("a", "A"),
      entry("b", "B"),
      entry("c", "C"),
      entry("keep", "K"),
    ];
    const ev = event(preparation("keep"), entries);
    // one token per entry -> every entry is its own chunk
    const options = { targetTokens: 1, estimateTokens: () => 1 };
    const saved: string[] = [];
    const eager = await captureRawSource(
      ev,
      async (content) => {
        saved.push(content);
        return String(saved.length);
      },
      options,
    );
    expect(saved).toHaveLength(3);
    expect(eager.chunks).toHaveLength(3);
    expect(eager.rawArtifactIds).toEqual(["1", "2", "3"]);
    const deferred = await captureRawSource(ev, undefined, options);
    expect(deferred.rawArtifactIds).toEqual([]);
    expect(deferred.chunks).toEqual(eager.chunks);
    expect(deferred.selection).toEqual(eager.selection);
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
  test("preserves opaque metadata only in exact raw artifacts", async () => {
    const entries = [
      {
        id: "a",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "useful reasoning",
              thinkingSignature: "encrypted-secret",
            },
          ],
          providerPayload: { encrypted_content: "opaque-secret" },
        },
      },
    ];
    const summaryInput = serializeSummaryEntries(entries);
    expect(summaryInput).toContain("useful reasoning");
    expect(summaryInput).toContain("opaque provider metadata omitted");
    expect(summaryInput).not.toContain("encrypted-secret");
    expect(summaryInput).not.toContain("opaque-secret");
    let rawArtifact = "";
    await captureRawSource(
      event(preparation("keep"), [...entries, entry("keep")]),
      async (content) => {
        rawArtifact = content;
        return "1";
      },
    );
    expect(rawArtifact).toContain("encrypted-secret");
    expect(rawArtifact).toContain("opaque-secret");
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
