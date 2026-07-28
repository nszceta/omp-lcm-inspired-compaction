import { describe, expect, test } from "bun:test";
import { summarizeText } from "../src/summarize.ts";
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
