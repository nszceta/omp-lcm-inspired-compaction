import { describe, expect, test } from "bun:test";
import { createLcmExpandHandler } from "../src/tools.ts";

describe("lcm_expand", () => {
  test("expands nodes, raw content, and cycles safely", async () => {
    const files: Record<string, string> = {
      "1": JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "condensed-summary",
        level: 1,
        summary: "parent",
        children: ["2", "1"],
        rawSources: [],
      }),
      "2": JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "leaf-summary",
        level: 0,
        summary: "leaf",
        children: [],
        rawSources: ["3"],
      }),
      "3": "exact raw",
    };
    const handler = createLcmExpandHandler(() => ({
      sessionManager: {
        getArtifactPath: async (id) => {
          const path = `/tmp/lcm-test-${id}`;
          await Bun.write(path, files[id] ?? "");
          return files[id] ? path : undefined;
        },
      },
    }));
    const out = await handler(
      { artifactId: "1", depth: 8, includeRaw: true },
      {},
    );
    expect(out).toContain("parent");
    expect(out).toContain("leaf");
    expect(out).toContain("cycle detected");
    expect(out).toContain("exact raw");
  });
  test("contains malformed and missing errors", async () => {
    const handler = createLcmExpandHandler(() => ({
      sessionManager: { getArtifactPath: async () => undefined },
    }));
    expect(await handler({ artifactId: "no" }, {})).toContain("numeric");
    expect(await handler({ artifactId: "4" }, {})).toContain("missing");
  });
  test("renders bounded single-line summaries for structural dumps", async () => {
    const path = "/tmp/lcm-structural-dump-9";
    await Bun.write(
      path,
      JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "condensed-summary",
        level: 2,
        summary: `first line\n${"detail ".repeat(100)}`,
        children: [],
        rawSources: [],
      }),
    );
    const handler = createLcmExpandHandler(
      () => ({
        sessionManager: { getArtifactPath: async () => path },
      }),
      { summaryLimit: 40, singleLineSummaries: true },
    );
    const out = await handler({ artifactId: "9", depth: 8 }, {});
    const summaryLine = out
      .split("\n")
      .find((line) => line.startsWith("Summary:"));
    expect(summaryLine).toBeDefined();
    expect(summaryLine?.length).toBeLessThanOrEqual(49);
    expect(summaryLine).not.toContain("detail detail detail detail detail");
  });
});
