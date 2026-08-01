import { describe, expect, test } from "bun:test";
import {
  deterministicSummary,
  RETRIEVAL_WORDING,
  type SummaryResult,
  summarizeText,
} from "../src/summarize.ts";
import { modelCall } from "./helpers.ts";

describe("summary convergence", () => {
  test("accepts a shrinking normal response", async () => {
    const m = modelCall("brief decision");
    const result = await summarizeText(
      { input: "a ".repeat(100), targetTokens: 80 },
      m.call,
      (s) => s.trim().split(/\s+/u).length,
    );
    expect(result.level).toBe("normal");
    expect(result.prose).toContain("brief decision");
  });
  test("escalates then deterministically bounds", async () => {
    const m = modelCall(["x".repeat(500), "y".repeat(500)]);
    const result = await summarizeText(
      { input: "source ".repeat(40), targetTokens: 20 },
      m.call,
      (s) => s.length,
    );
    expect(["aggressive", "deterministic"]).toContain(result.level);
    expect(result.prose.length).toBeLessThanOrEqual(200);
  });
  test("bounds opaque fallback with the default token estimate", async () => {
    const opaque = "x".repeat(20_000);
    const result = await summarizeText(
      { input: opaque, targetTokens: 100 },
      async () => {
        throw new Error("unavailable");
      },
    );
    expect(result.level).toBe("deterministic");
    expect(result.tokenCount).toBeLessThanOrEqual(100);
    expect(result.prose.length).toBeLessThanOrEqual(400);
    expect(result.prose).not.toContain(opaque);
  });
  test("propagates abort", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      summarizeText(
        { input: "x", targetTokens: 10, signal: c.signal },
        modelCall("x").call,
        (s) => s.length,
      ),
    ).rejects.toThrow();
  });
});

describe("deterministicSummary", () => {
  test("returns level deterministic with bounded prose containing the fallback marker", () => {
    const result = deterministicSummary("source ".repeat(400), 50);
    expect(result.level).toBe("deterministic");
    expect(result.prose).toContain("deterministic fallback");
    expect(result.tokenCount).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(50);
    expect(result.retrieval.startsWith("Retrieval:")).toBe(true);
    const roomy = deterministicSummary("source ".repeat(400), 1_000);
    expect(roomy.retrieval).toBe(RETRIEVAL_WORDING);
  });

  test("matches summarizeText deterministic branch exactly for identical inputs", async () => {
    const input = "source ".repeat(400);
    const target = 50;
    const count = (s: string) => Math.ceil(s.length / 4);
    const viaText = await summarizeText(
      { input, targetTokens: target },
      async () => {
        throw new Error("unavailable");
      },
      count,
    );
    const viaDirect = deterministicSummary(input, target, count);
    expect(viaDirect.prose).toBe(viaText.prose);
    expect(viaDirect.retrieval).toBe(viaText.retrieval);
    expect(viaDirect.tokenCount).toBe(viaText.tokenCount);
    expect(viaDirect.level).toBe(viaText.level);
    expect(viaText.level).toBe("deterministic");
  });

  test("never throws and stays bounded on hostile targets", () => {
    const input = "x".repeat(2_000);
    for (const target of [
      Number.NaN,
      -10,
      0,
      1,
      1.9,
      Number.POSITIVE_INFINITY,
    ]) {
      let result: SummaryResult | undefined;
      expect(() => {
        result = deterministicSummary(input, target);
      }).not.toThrow();
      expect(result?.level).toBe("deterministic");
      expect(result?.tokenCount).toBeGreaterThanOrEqual(0);
      if (Number.isFinite(target) && target >= 1) {
        expect(result?.tokenCount).toBeLessThanOrEqual(
          Math.max(1, Math.floor(target)),
        );
      }
    }
  });
});
