import { describe, expect, test } from "bun:test";
import { planSummaryBatches, type SummaryBatch } from "../src/batch.ts";
import type { RawChunk, SourceEntry } from "../src/source.ts";

const OMISSION_MARKER =
  "[opaque provider metadata omitted; preserved in raw artifact]";

function chunk(
  entries: SourceEntry[],
  tokenCount: number,
  _index: number,
): RawChunk {
  return {
    entries,
    content: `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    tokenCount,
  };
}

function entry(id: string, extra: Record<string, unknown> = {}): SourceEntry {
  return { id, ...extra };
}

describe("planSummaryBatches", () => {
  test("empty input returns []", () => {
    expect(planSummaryBatches([], [], { maxInputTokens: 10 })).toEqual([]);
  });

  test("one chunk yields one batch with full provenance", () => {
    const chunks = [chunk([entry("e1"), entry("e2")], 7, 0)];
    const batches = planSummaryBatches(chunks, ["100"], {
      maxInputTokens: 10,
    });
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.rawArtifactIds).toEqual(["100"]);
    expect(batch.sourceEntryIds).toEqual(["e1", "e2"]);
    expect(batch.entryCount).toBe(2);
    expect(batch.estimatedInputTokens).toBe(7);
    expect(batch.oversized).toBe(false);
    expect(batch.input).toContain('"id":"e1"');
    expect(batch.input).toContain('"id":"e2"');
  });

  test("chunks summing exactly to the budget stay in one batch; one extra token splits", () => {
    const chunks = [
      chunk([entry("a")], 3, 0),
      chunk([entry("b")], 4, 1),
      chunk([entry("c")], 5, 2),
    ];
    // 3 + 4 + 5 = 12 == maxInputTokens -> single batch
    const exact = planSummaryBatches(chunks, ["100", "101", "102"], {
      maxInputTokens: 12,
    });
    expect(exact).toHaveLength(1);
    expect(exact[0]?.sourceEntryIds).toEqual(["a", "b", "c"]);
    expect(exact[0]?.estimatedInputTokens).toBe(12);
    // same budget, but chunks sum to 13 (one extra token) -> splits into two
    const over = planSummaryBatches(
      [
        chunk([entry("a")], 3, 0),
        chunk([entry("b")], 4, 1),
        chunk([entry("c")], 6, 2),
      ],
      ["100", "101", "102"],
      { maxInputTokens: 12 },
    );
    expect(over).toHaveLength(2);
    expect(over[0]?.sourceEntryIds).toEqual(["a", "b"]);
    expect(over[1]?.sourceEntryIds).toEqual(["c"]);
  });

  test("adjacent chunks crossing a boundary pack greedily in order", () => {
    // [6] then [5, 4]: 6 > 10 - 0? no: 6 <= 10; 6+5=11 > 10 -> close [6]; 5+4=9 <= 10 -> [5, 4]
    const chunks = [
      chunk([entry("a")], 6, 0),
      chunk([entry("b")], 5, 1),
      chunk([entry("c")], 4, 2),
      chunk([entry("d")], 7, 3),
      chunk([entry("e")], 3, 4),
    ];
    const batches = planSummaryBatches(chunks, ["0", "1", "2", "3", "4"], {
      maxInputTokens: 10,
    });
    expect(batches).toHaveLength(3);
    expect(batches[0]?.sourceEntryIds).toEqual(["a"]);
    expect(batches[1]?.sourceEntryIds).toEqual(["b", "c"]);
    expect(batches[2]?.sourceEntryIds).toEqual(["d", "e"]);
    expect(batches[0]?.rawArtifactIds).toEqual(["0"]);
    expect(batches[1]?.rawArtifactIds).toEqual(["1", "2"]);
    expect(batches[2]?.rawArtifactIds).toEqual(["3", "4"]);
  });

  test("single oversized entry gets its own batch, oversized, input never truncated", () => {
    const entryJson = { id: "huge", body: "x".repeat(500) };
    const chunks = [chunk([entryJson as SourceEntry], 100, 0)];
    const batches = planSummaryBatches(chunks, ["42"], { maxInputTokens: 10 });
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.oversized).toBe(true);
    expect(batch.estimatedInputTokens).toBe(100);
    expect(batch.entryCount).toBe(1);
    // full entry present verbatim, trailing newline appended by serializer
    expect(batch.input).toContain(JSON.stringify(entryJson));
    expect(batch.input.endsWith("\n")).toBe(true);
    expect(batch.input.length).toBe(JSON.stringify(entryJson).length + 1);
    // an oversized chunk never shares a batch with a following chunk
    const next = planSummaryBatches(
      [chunks[0], chunk([entry("small")], 2, 1)],
      ["42", "43"],
      { maxInputTokens: 10 },
    );
    expect(next).toHaveLength(2);
    expect(next[0]?.oversized).toBe(true);
    expect(next[1]?.oversized).toBe(false);
  });

  test("provenance exactly covers chunks and entries once, in order", () => {
    const chunks = [
      chunk([entry("e1"), entry("e2")], 5, 0),
      chunk([entry("e3")], 6, 1),
      chunk([entry("e4"), entry("e5")], 4, 2),
      chunk([entry("e6")], 7, 3),
    ];
    const ids = ["101", "102", "103", "104"];
    const batches = planSummaryBatches(chunks, ids, { maxInputTokens: 10 });
    const rawIds = batches.flatMap((b) => b.rawArtifactIds);
    const sourceIds = batches.flatMap((b) => b.sourceEntryIds);
    expect(rawIds).toEqual(ids);
    expect(sourceIds).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(new Set(rawIds).size).toBe(4);
    expect(new Set(sourceIds).size).toBe(6);
    expect(batches.reduce((n, b) => n + b.entryCount, 0)).toBe(6);
  });

  test("stable ordering: same input always yields identical batches; order never changes", () => {
    const chunks = [
      chunk([entry("e1")], 9, 0),
      chunk([entry("e2")], 2, 1),
      chunk([entry("e3")], 8, 2),
      chunk([entry("e4")], 3, 3),
    ];
    const options = { maxInputTokens: 10 };
    const first = planSummaryBatches(chunks, ["1", "2", "3", "4"], options);
    const second = planSummaryBatches(chunks, ["1", "2", "3", "4"], options);
    expect(second).toEqual(first);
    // chunks are walked in input order regardless of tokenCount
    expect(first.flatMap((b) => b.sourceEntryIds)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    expect(first.flatMap((b) => b.rawArtifactIds)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    // batches start at successive input positions; token counts never reorder chunks
    expect(first.map((b) => b.sourceEntryIds[0])).toEqual(["e1", "e2", "e4"]);
  });

  test("opaque provider metadata is omitted from model-visible input", () => {
    const secret = "super-secret-payload-7f3a";
    const chunks = [
      chunk(
        [
          entry("e1", {
            encryptedContent: `enc:${secret}`,
            encrypted_content: `alt:${secret}`,
            providerPayload: { apiKey: secret },
            thinkingSignature: `sig:${secret}`,
          }),
        ],
        5,
        0,
      ),
    ];
    const batches = planSummaryBatches(chunks, ["9"], { maxInputTokens: 10 });
    const input = batches[0]?.input ?? "";
    expect(input).toContain(OMISSION_MARKER);
    expect(input).not.toContain(secret);
    expect(input).not.toContain(`enc:${secret}`);
    expect(input).not.toContain(`alt:${secret}`);
    expect(input).not.toContain(`sig:${secret}`);
    // visible fields survive
    expect(input).toContain('"id":"e1"');
  });

  test("mismatched raw artifact count throws", () => {
    const chunks = [chunk([entry("a")], 1, 0), chunk([entry("b")], 1, 1)];
    expect(() =>
      planSummaryBatches(chunks, ["1"], { maxInputTokens: 10 }),
    ).toThrow("raw artifact count mismatch");
    expect(() =>
      planSummaryBatches([chunks[0]], ["1", "2"], { maxInputTokens: 10 }),
    ).toThrow("raw artifact count mismatch");
    expect(() =>
      planSummaryBatches([chunks[0]], [], { maxInputTokens: 10 }),
    ).toThrow("raw artifact count mismatch");
  });

  test("budget clamps to at least 1", () => {
    const chunks = [chunk([entry("a")], 1, 0), chunk([entry("b")], 2, 1)];
    for (const maxInputTokens of [0, -5, 0.4]) {
      const batches = planSummaryBatches(chunks, ["1", "2"], {
        maxInputTokens,
      });
      expect(batches[0]?.estimatedInputTokens).toBe(1);
      expect(batches[0]?.oversized).toBe(false);
      expect(batches[1]?.estimatedInputTokens).toBe(2);
      expect(batches[1]?.oversized).toBe(true);
    }
    // fractional budgets floor, then clamp: 2.9 -> 2
    const fractional = planSummaryBatches(
      [chunk([entry("a")], 2, 0), chunk([entry("b")], 1, 1)],
      ["1", "2"],
      { maxInputTokens: 2.9 },
    );
    expect(fractional).toHaveLength(2);
  });

  test("aborted signal throws DOMException AbortError per chunk", () => {
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      planSummaryBatches(
        [chunk([entry("a")], 1, 0), chunk([entry("b")], 1, 1)],
        ["1", "2"],
        { maxInputTokens: 10, signal: controller.signal },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
    expect((caught as DOMException).message).toBe("Aborted");
  });

  test("abort mid-walk stops before later chunks are consumed", () => {
    const controller = new AbortController();
    const chunks = [
      chunk([entry("a")], 1, 0),
      chunk([entry("b")], 1, 1),
      chunk([entry("c")], 1, 2),
    ];
    const run = (): SummaryBatch[] =>
      planSummaryBatches(chunks, ["1", "2", "3"], {
        maxInputTokens: 10,
        signal: controller.signal,
      });
    expect(run()).toHaveLength(1);
    controller.abort();
    expect(run).toThrow(DOMException);
  });
});
