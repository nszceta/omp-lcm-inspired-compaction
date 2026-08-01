import { describe, expect, test } from "bun:test";
import {
  createLcmDescribeHandler,
  createLcmExpandHandler,
  createLcmGrepHandler,
  lcmDescribeTool,
  lcmGrepTool,
  registerLcmDescribeTool,
  registerLcmGrepTool,
} from "../src/tools.ts";

const fixturesDir = `${import.meta.dir}/fixtures`;
const fixturePath = (name: string) => `${fixturesDir}/${name}`;

async function writeArtifacts(
  files: Record<string, string>,
  dir: string,
): Promise<{ getArtifactPath: (id: string) => Promise<string | undefined> }> {
  const paths = new Map<string, string>();
  for (const [id, content] of Object.entries(files)) {
    const path = `${dir}/${id}`;
    await Bun.write(path, content);
    paths.set(id, path);
  }
  return {
    getArtifactPath: async (id: string) => paths.get(id),
  };
}

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

describe("lcm_describe", () => {
  test("node artifact: metadata matches content, full summary, no model call", async () => {
    const node = {
      schema: "omp-lcm-node/v1",
      kind: "leaf-summary",
      level: 0,
      summary: "Full summary text here.",
      children: [],
      rawSources: ["21"],
      sourceEntryCount: 3,
    };
    const resolver = await writeArtifacts(
      { "20": JSON.stringify(node) },
      "/tmp/lcm-describe-node",
    );
    let summarizerCalls = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          summarizerCalls++;
          throw new Error("summarizer must not run for node artifacts");
        },
      },
    );
    const out = await handler({ artifactId: "20", explore: true }, {});
    expect(out).toContain("Node artifact://20 [leaf-summary, level 0]");
    expect(out).toContain("Raw sources: artifact://21");
    expect(out).toContain("Source entries: 3");
    expect(out).toContain("Token estimate: ~");
    expect(out).toContain("Summary:");
    expect(out).toContain("Full summary text here.");
    expect(summarizerCalls).toBe(0);
  });

  test("raw artifact: entry count, byte size, token estimate, preview", async () => {
    const raw = ["one", "two", "three"]
      .map((id) => JSON.stringify({ type: "message", id, content: id }))
      .join("\n");
    const resolver = await writeArtifacts(
      { "40": raw },
      "/tmp/lcm-describe-raw",
    );
    let summarizerCalls = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          summarizerCalls++;
          return "";
        },
      },
    );
    const out = await handler({ artifactId: "40" }, {});
    expect(out).toContain("Raw artifact://40");
    expect(out).toContain("Entries: 3");
    expect(out).toContain(
      `Size: ${new TextEncoder().encode(raw).length} bytes`,
    );
    expect(out).toContain("Token estimate:");
    expect(out).toContain("Preview:");
    expect(out).toContain('"content":"one"');
    expect(summarizerCalls).toBe(0);
  });

  test("spilled artifact with explore=false: metadata only, no model call", async () => {
    const spilled = JSON.stringify({ type: "text", text: "hello world" });
    const resolver = await writeArtifacts(
      { "50": spilled },
      "/tmp/lcm-describe-spill",
    );
    let summarizerCalls = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          summarizerCalls++;
          return "x";
        },
      },
    );
    const out = await handler({ artifactId: "50" }, {});
    expect(out).toContain("Artifact artifact://50");
    expect(out).toContain(
      `Size: ${new TextEncoder().encode(spilled).length} bytes`,
    );
    expect(out).toContain("Lines: 1");
    expect(out).not.toContain("Exploration:");
    expect(out).not.toContain("hello world");
    expect(summarizerCalls).toBe(0);
  });

  test("explore=true: JSON fixture yields keys and types", async () => {
    const content = await Bun.file(fixturePath("describe-json.json")).text();
    const resolver = await writeArtifacts(
      { "60": content },
      "/tmp/lcm-describe-json",
    );
    let summarizerCalls = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          summarizerCalls++;
          return "";
        },
      },
    );
    const out = await handler({ artifactId: "60", explore: true }, {});
    expect(out).toContain("Exploration:");
    expect(out).toContain("JSON array: 2 elements");
    expect(out).toContain("- name: string");
    expect(out).toContain("- score: number");
    expect(out).toContain("- tags: array");
    expect(summarizerCalls).toBe(0);
  });

  test("explore=true: CSV fixture yields columns and rows", async () => {
    const content = await Bun.file(fixturePath("describe-csv.csv")).text();
    const resolver = await writeArtifacts(
      { "61": content },
      "/tmp/lcm-describe-csv",
    );
    let summarizerCalls = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          summarizerCalls++;
          return "";
        },
      },
    );
    const out = await handler({ artifactId: "61", explore: true }, {});
    expect(out).toContain("CSV: 2 data rows, 3 columns");
    expect(out).toContain("Header: name,age,city");
    expect(out).toContain(
      "Consistency: all 2 data rows match the 3-column header",
    );
    expect(summarizerCalls).toBe(0);
  });

  test("explore=true: SQL fixture yields statement counts and table names", async () => {
    const content = await Bun.file(fixturePath("describe-sql.sql")).text();
    const resolver = await writeArtifacts(
      { "62": content },
      "/tmp/lcm-describe-sql",
    );
    let summarizerCalls = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          summarizerCalls++;
          return "";
        },
      },
    );
    const out = await handler({ artifactId: "62", explore: true }, {});
    expect(out).toContain("SQL statements:");
    expect(out).toContain("2 create table");
    expect(out).toContain("Tables: users, orders");
    expect(summarizerCalls).toBe(0);
  });

  test("explore=true: code fixture yields signatures and imports", async () => {
    const content = await Bun.file(fixturePath("describe-code.txt")).text();
    const resolver = await writeArtifacts(
      { "63": content },
      "/tmp/lcm-describe-code",
    );
    let summarizerCalls = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          summarizerCalls++;
          return "";
        },
      },
    );
    const out = await handler({ artifactId: "63", explore: true }, {});
    expect(out).toContain("Code signatures");
    expect(out).toContain("function add");
    expect(out).toContain("const greet");
    expect(out).toContain("Imports/modules");
    expect(summarizerCalls).toBe(0);
  });

  test("explore=true: prose fixture uses the injected summarizer seam", async () => {
    const content = await Bun.file(fixturePath("describe-prose.txt")).text();
    const resolver = await writeArtifacts(
      { "70": content },
      "/tmp/lcm-describe-prose",
    );
    let called = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async (text, _signal) => {
          called++;
          expect(text).toBe(content);
          return "MODEL SUMMARY";
        },
      },
    );
    const out = await handler({ artifactId: "70", explore: true }, {});
    expect(called).toBe(1);
    expect(out).toContain("Summary: MODEL SUMMARY");
  });

  test("explore=true: summarizer rejection degrades to a bounded preview", async () => {
    const content = "long prose ".repeat(400);
    const resolver = await writeArtifacts(
      { "71": content },
      "/tmp/lcm-describe-reject",
    );
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          throw new Error("model down");
        },
      },
    );
    const out = await handler({ artifactId: "71", explore: true }, {});
    expect(out).toContain("Preview:");
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(content.length + 500);
  });

  test("explore=true: aborted signal degrades to preview without calling the seam", async () => {
    const content = "plain prose spill for abort";
    const resolver = await writeArtifacts(
      { "72": content },
      "/tmp/lcm-describe-abort",
    );
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    const handler = createLcmDescribeHandler(
      () => ({ sessionManager: resolver }),
      {
        summarize: async () => {
          called++;
          return "NOPE";
        },
      },
    );
    const out = await handler(
      { artifactId: "72", explore: true },
      {},
      controller.signal,
    );
    expect(called).toBe(0);
    expect(out).toContain("Preview:");
    expect(out).not.toContain("NOPE");
  });

  test("context lacking model/modelRegistry: plain preview, no model call", async () => {
    const content = "a spilled prose note without any model context";
    const resolver = await writeArtifacts(
      { "73": content },
      "/tmp/lcm-describe-nomodel",
    );
    const handler = createLcmDescribeHandler(() => ({
      sessionManager: resolver,
    }));
    const out = await handler({ artifactId: "73", explore: true }, {});
    expect(out).toContain("Preview:");
    expect(out).toContain(content);
  });

  test("malformed lcm node yields a contained error", async () => {
    const resolver = await writeArtifacts(
      {
        "74": JSON.stringify({
          schema: "omp-lcm-node/v1",
          kind: "leaf-summary",
        }),
      },
      "/tmp/lcm-describe-malformed",
    );
    const handler = createLcmDescribeHandler(() => ({
      sessionManager: resolver,
    }));
    const out = await handler({ artifactId: "74" }, {});
    expect(out).toContain("lcm_describe error");
    expect(out).toContain("malformed lcm node");
  });

  test("missing artifact yields a contained error", async () => {
    const resolver = await writeArtifacts({}, "/tmp/lcm-describe-missing");
    const handler = createLcmDescribeHandler(() => ({
      sessionManager: resolver,
    }));
    const out = await handler({ artifactId: "75" }, {});
    expect(out).toContain("lcm_describe error");
    expect(out).toContain("artifact://75");
  });

  test("tool definition requires artifactId and defaults explore to false", () => {
    expect(lcmDescribeTool.name).toBe("lcm_describe");
    expect(lcmDescribeTool.parameters.required).toEqual(["artifactId"]);
    expect(lcmDescribeTool.parameters.properties.explore.default).toBe(false);
  });
});

describe("lcm_grep", () => {
  const grepDag: Record<string, string> = {
    "10": JSON.stringify({
      schema: "omp-lcm-node/v1",
      kind: "condensed-summary",
      level: 1,
      summary: "root",
      children: ["11", "12"],
      rawSources: [],
    }),
    "11": JSON.stringify({
      schema: "omp-lcm-node/v1",
      kind: "leaf-summary",
      level: 0,
      summary: "left leaf",
      children: [],
      rawSources: ["101"],
    }),
    "12": JSON.stringify({
      schema: "omp-lcm-node/v1",
      kind: "leaf-summary",
      level: 0,
      summary: "right leaf",
      children: [],
      rawSources: ["102"],
    }),
    "101": "needle at one\nnothing here\nneedle at three\n",
    "102": "NEEDLE uppercase\nneedle lower\nneedle third\n",
  };
  const lcmEntries = [
    {
      type: "compaction",
      id: "5",
      preserveData: {
        ompLcmArtifactsV1: {
          version: 1,
          generation: 1,
          roots: [
            {
              artifactId: "99",
              level: 0,
              summary: "old root",
              sourceEntryCount: 1,
              tokenCount: 1,
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "6",
      message: { role: "user", content: "hi" },
    },
    {
      type: "compaction",
      id: "7",
      preserveData: {
        ompLcmArtifactsV1: {
          version: 1,
          generation: 2,
          roots: [
            {
              artifactId: "10",
              level: 1,
              summary: "root",
              sourceEntryCount: 5,
              tokenCount: 100,
            },
          ],
        },
      },
    },
  ];
  const dagContext = (resolver: {
    getArtifactPath: (id: string) => Promise<string | undefined>;
  }) => ({
    sessionManager: {
      getArtifactPath: resolver.getArtifactPath,
      getEntries: () => lcmEntries,
    },
  });

  test("roots from latest compaction entry; matches grouped by node; case-insensitive default", async () => {
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-dag");
    const handler = createLcmGrepHandler(() => dagContext(resolver));
    const out = await handler({ pattern: "needle" }, {});
    expect(out).toContain("case-sensitive: no");
    expect(out).toContain("Node artifact://11 [leaf-summary, level 0]:");
    expect(out).toContain("artifact://101:1:");
    expect(out).toContain("artifact://101:3:");
    expect(out).toContain("Node artifact://12 [leaf-summary, level 0]:");
    expect(out).toContain("artifact://102:1:"); // NEEDLE matched case-insensitively
    expect(out).toContain("artifact://102:2:");
    expect(out).toContain("artifact://102:3:");
    expect(out).not.toContain("Node artifact://99"); // latest compaction wins
    expect(out).not.toContain("artifact://99");
  });

  test("caseSensitive flag excludes case-variant matches", async () => {
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-dag");
    const handler = createLcmGrepHandler(() => dagContext(resolver));
    const out = await handler({ pattern: "needle", caseSensitive: true }, {});
    expect(out).toContain("case-sensitive: yes");
    expect(out).toContain("artifact://101:1:");
    expect(out).toContain("artifact://102:2:");
    expect(out).not.toContain("artifact://102:1:");
  });

  test("summaryId scopes the traversal to that node", async () => {
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-dag");
    const handler = createLcmGrepHandler(() => dagContext(resolver));
    const out = await handler({ pattern: "needle", summaryId: "11" }, {});
    expect(out).toContain("under artifact://11");
    expect(out).toContain("artifact://101:1:");
    expect(out).toContain("artifact://101:3:");
    expect(out).not.toContain("Node artifact://12");
    expect(out).not.toContain("artifact://102");
  });

  test("limit pagination: 2 of 5 matches with an explicit truncation note", async () => {
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-dag");
    const handler = createLcmGrepHandler(() => dagContext(resolver));
    const out = await handler({ pattern: "needle", limit: 2 }, {});
    expect(out).toContain("artifact://101:1:");
    expect(out).toContain("artifact://101:3:");
    expect(out).not.toContain("artifact://102:1:");
    expect(out).toContain("showing 2 of 5 matches");
  });

  test("invalid regex yields a contained error", async () => {
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-dag");
    const handler = createLcmGrepHandler(() => dagContext(resolver));
    const out = await handler({ pattern: "(" }, {});
    expect(out).toContain("lcm_grep error: invalid regular expression");
  });

  test("missing summary artifact yields a contained error", async () => {
    const resolver = await writeArtifacts({}, "/tmp/lcm-grep-missing");
    const handler = createLcmGrepHandler(() => dagContext(resolver));
    const out = await handler({ pattern: "needle", summaryId: "999" }, {});
    expect(out).toContain("lcm_grep error");
    expect(out).toContain("artifact://999");
  });

  test("no LCM history yields helpful text", async () => {
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-nohistory");
    const handler = createLcmGrepHandler(() => ({
      sessionManager: {
        getArtifactPath: resolver.getArtifactPath,
        getEntries: () => [
          {
            type: "message",
            id: "1",
            message: { role: "user", content: "hi" },
          },
        ],
      },
    }));
    const out = await handler({ pattern: "needle" }, {});
    expect(out).toContain("lcm_grep error: no LCM history found");
  });

  test("falls back to getBranch and accepts async entries", async () => {
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-branch");
    const handler = createLcmGrepHandler(() => ({
      sessionManager: {
        getArtifactPath: resolver.getArtifactPath,
        getBranch: async () => lcmEntries,
      },
    }));
    const out = await handler({ pattern: "needle" }, {});
    expect(out).toContain("artifact://101:1:");
    expect(out).toContain("artifact://102:3:");
  });

  test("cycle in the DAG terminates; each node visited once", async () => {
    const files: Record<string, string> = {
      "15": JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "condensed-summary",
        level: 1,
        summary: "cycler",
        children: ["16", "15"],
        rawSources: [],
      }),
      "16": JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "leaf-summary",
        level: 0,
        summary: "leaf",
        children: ["15"],
        rawSources: ["105"],
      }),
      "105": "needle in cycle\n",
    };
    const resolver = await writeArtifacts(files, "/tmp/lcm-grep-cycle");
    const handler = createLcmGrepHandler(() => ({
      sessionManager: {
        getArtifactPath: resolver.getArtifactPath,
        getEntries: () => [
          {
            type: "compaction",
            id: "9",
            preserveData: {
              ompLcmArtifactsV1: {
                version: 1,
                generation: 4,
                roots: [
                  {
                    artifactId: "15",
                    level: 1,
                    summary: "cycler",
                    sourceEntryCount: 2,
                    tokenCount: 20,
                  },
                ],
              },
            },
          },
        ],
      },
    }));
    const out = await handler({ pattern: "needle" }, {});
    expect(out).toContain("artifact://105:1:");
    const node16Headers = out
      .split("\n")
      .filter((line) => line.includes("Node artifact://16"));
    expect(node16Headers).toHaveLength(1);
  });

  test("output bounded at 12_000 chars with an explicit truncation note", async () => {
    const bigRaw = Array.from(
      { length: 300 },
      (_, i) => `needle ${"x".repeat(600)} ${i}`,
    ).join("\n");
    const files: Record<string, string> = {
      "13": JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "leaf-summary",
        level: 0,
        summary: "big",
        children: [],
        rawSources: ["103"],
      }),
      "103": bigRaw,
    };
    const resolver = await writeArtifacts(files, "/tmp/lcm-grep-bounded");
    const handler = createLcmGrepHandler(() => ({
      sessionManager: {
        getArtifactPath: resolver.getArtifactPath,
        getEntries: () => [
          {
            type: "compaction",
            id: "8",
            preserveData: {
              ompLcmArtifactsV1: {
                version: 1,
                generation: 3,
                roots: [
                  {
                    artifactId: "13",
                    level: 0,
                    summary: "big",
                    sourceEntryCount: 1,
                    tokenCount: 1,
                  },
                ],
              },
            },
          },
        ],
      },
    }));
    const out = await handler({ pattern: "needle" }, {});
    expect(out.length).toBeLessThanOrEqual(12_100);
    expect(out).toContain("grep output truncated");
  });

  test("raw artifacts over 256 KiB are reported as partial scans", async () => {
    const bigRaw = `needle near start\n${"z".repeat(300_000)}`;
    const files: Record<string, string> = {
      "14": JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "leaf-summary",
        level: 0,
        summary: "partial",
        children: [],
        rawSources: ["104"],
      }),
      "104": bigRaw,
    };
    const resolver = await writeArtifacts(files, "/tmp/lcm-grep-partial");
    const handler = createLcmGrepHandler(() => ({
      sessionManager: {
        getArtifactPath: resolver.getArtifactPath,
        getEntries: () => [
          {
            type: "compaction",
            id: "9",
            preserveData: {
              ompLcmArtifactsV1: {
                version: 1,
                generation: 4,
                roots: [
                  {
                    artifactId: "14",
                    level: 0,
                    summary: "partial",
                    sourceEntryCount: 1,
                    tokenCount: 1,
                  },
                ],
              },
            },
          },
        ],
      },
    }));
    const out = await handler({ pattern: "needle" }, {});
    expect(out).toContain("artifact://104:1:");
    expect(out).toContain("(partial scan) artifact://104");
  });

  test("unreadable raw artifacts are reported as missing, not silently skipped", async () => {
    const files: Record<string, string> = {
      "14": JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "leaf-summary",
        level: 0,
        summary: "missing raw",
        children: [],
        rawSources: ["104", "105"],
      }),
      "105": "needle in the readable raw",
    };
    const resolver = await writeArtifacts(files, "/tmp/lcm-grep-missing");
    const handler = createLcmGrepHandler(() => ({
      sessionManager: {
        getArtifactPath: async (id: string) =>
          id === "104" ? undefined : resolver.getArtifactPath(id),
        getEntries: () => [
          {
            type: "compaction",
            id: "9",
            preserveData: {
              ompLcmArtifactsV1: {
                version: 1,
                generation: 4,
                roots: [
                  {
                    artifactId: "14",
                    level: 0,
                    summary: "missing raw",
                    sourceEntryCount: 1,
                    tokenCount: 1,
                  },
                ],
              },
            },
          },
        ],
      },
    }));
    const out = await handler({ pattern: "needle" }, {});
    expect(out).toContain("artifact://105:1:");
    expect(out).toContain("(missing) artifact://104");
  });

  test("tool definitions and registration wire execute to the handlers", async () => {
    expect(lcmGrepTool.name).toBe("lcm_grep");
    expect(lcmGrepTool.parameters.required).toEqual(["pattern"]);
    const resolver = await writeArtifacts(grepDag, "/tmp/lcm-grep-register");
    const context = {
      sessionManager: {
        getArtifactPath: resolver.getArtifactPath,
        getEntries: () => lcmEntries,
      },
    };
    const definitions: unknown[] = [];
    const register = (definition: unknown) => {
      definitions.push(definition);
      return definition;
    };
    const grepDef = registerLcmGrepTool(register, context) as {
      name: string;
      execute: (
        callId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        runtimeContext: unknown,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    };
    const describeDef = registerLcmDescribeTool(register, context) as {
      name: string;
    };
    expect(definitions).toHaveLength(2);
    expect(grepDef.name).toBe("lcm_grep");
    expect(describeDef.name).toBe("lcm_describe");
    const result = await grepDef.execute(
      "t1",
      { pattern: "needle" },
      undefined,
      undefined,
      undefined,
    );
    expect(result.content[0].text).toContain("artifact://101:1:");
    expect(result.content[0].text).toContain("case-sensitive: no");
  });
});
