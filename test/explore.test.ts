import { describe, expect, mock, test } from "bun:test";
import { detectKind, exploreContent } from "../src/explore.ts";

// Hand-written fixtures (allowed for parsing tests).

const JSON_ARRAY_FIXTURE = `[
  { "id": 1, "name": "ada", "tags": ["math"], "meta": { "x": 1 } },
  { "id": 2, "name": "grace", "tags": ["navy"] },
  { "id": 3, "name": "alan" }
]`;

const JSON_OBJECT_FIXTURE = `{
  "name": "ada",
  "age": 36,
  "active": true,
  "score": null,
  "tags": ["math", "poetry"],
  "profile": { "city": "london" }
}`;

const CSV_FIXTURE = [
  "id,name,email",
  "1,Ada,ada@example.com",
  "2,Grace,grace@example.com",
].join("\n");

const CSV_QUOTED_FIXTURE = ["id,name", '1,"Doe, Jane"', '2,"Smith, John"'].join(
  "\n",
);

const CSV_RAGGED_FIXTURE = ["a,b,c", "1,2", "3,4,5", "6,7,8"].join("\n");

const SQL_FIXTURE = [
  "create table users (id int);",
  "create table orders (id int, user_id int);",
  "insert into users (id) values (1);",
  "insert into orders (id, user_id) values (2, 1);",
  "select * from users;",
  "update orders set user_id = 2;",
  "delete from users where id = 9;",
  "alter table orders add column note text;",
].join("\n");

const CODE_FIXTURE = [
  'import { readFile } from "node:fs";',
  'import path from "node:path";',
  "",
  "export function add(a, b) {",
  "  return a + b;",
  "}",
  "",
  "class Widget {",
  "  render() {}",
  "}",
  "",
  "export const handler = async (req) => {",
  "  return req;",
  "};",
  "",
  "const helper = (x) => x * 2;",
  "",
  'const mod = require("node:module");',
].join("\n");

const PROSE_HEAD = "Once upon a time there was a very long story";
const PROSE_TAIL = "and they all lived happily ever after";
const LONG_PROSE = `${PROSE_HEAD}${" ".repeat(300)}${PROSE_TAIL}`;

const WIDE_ARRAY_CONTENT = JSON.stringify([
  { a: 1, b: 2 },
  { c: 3, d: 4 },
  { e: 5, f: 6 },
  { g: 7, h: 8 },
  { i: 9, j: 10 },
]);

function wideObject(keyCount: number): string {
  const record: Record<string, number> = {};
  for (let i = 0; i < keyCount; i++) {
    record[`key${i}`] = i;
  }
  return JSON.stringify(record);
}

const MANY_TABLES = Array.from(
  { length: 25 },
  (_, i) => `create table t${i} (id int);`,
).join("\n");

const MANY_CODE = `${Array.from(
  { length: 25 },
  (_, i) => `function f${i}(${i}) {}`,
).join("\n")}\n${Array.from(
  { length: 12 },
  (_, i) => `import mod${i} from "pkg${i}";`,
).join("\n")}`;

function keyLines(output: string): string[] {
  return output.split("\n").filter((line) => line.startsWith("- "));
}

describe("detectKind", () => {
  test("classifies JSON (including whitespace-padded)", () => {
    expect(detectKind('{"a": 1}')).toBe("json");
    expect(detectKind("[1, 2, 3]")).toBe("json");
    expect(detectKind('  {"a": [1, 2]}\n')).toBe("json");
    expect(detectKind('"just a string"')).toBe("json");
  });

  test("classifies CSV (comma, tab, and quoted fields)", () => {
    expect(detectKind("a,b\n1,2")).toBe("csv");
    expect(detectKind('a,b\n"1,5",2')).toBe("csv");
    expect(detectKind("a\tb\n1\t2")).toBe("csv");
  });

  test("CSV needs at least two lines with the same field count", () => {
    expect(detectKind("a,b\n1")).toBe("prose");
    expect(detectKind("a,b,c\n1,2")).toBe("prose");
  });

  test("classifies SQL by statement keywords", () => {
    expect(detectKind("create table users (id int);")).toBe("sql");
    expect(detectKind("select * from users;")).toBe("sql");
    expect(detectKind("insert into users (id) values (1);")).toBe("sql");
    expect(detectKind("alter table users add column x int;")).toBe("sql");
  });

  test("classifies code by code signals", () => {
    expect(detectKind("function foo() { return 1; }")).toBe("code");
    expect(detectKind("class A {}")).toBe("code");
    expect(detectKind("const f = (x) => x")).toBe("code");
    expect(detectKind("def foo():\n  pass")).toBe("code");
    expect(detectKind("import os")).toBe("code");
    expect(detectKind("#include <stdio.h>")).toBe("code");
    expect(detectKind("{ hello }")).toBe("code");
  });

  test("everything else is prose", () => {
    expect(detectKind("Once upon a time, there was a story.")).toBe("prose");
    expect(detectKind("Just some plain words here.")).toBe("prose");
  });
});

describe("exploreContent JSON", () => {
  test("top-level array: element count, sampled keys with types, per-key counts", async () => {
    const output = await exploreContent({ content: JSON_ARRAY_FIXTURE });
    expect(output).toContain("JSON array: 3 elements");
    expect(output).toContain("Keys (sampled from first 3 elements):");
    expect(output).toContain("- id: number (in 3/3 elements)");
    expect(output).toContain("- name: string (in 3/3 elements)");
    expect(output).toContain("- tags: array (in 2/3 elements)");
    expect(output).toContain("- meta: object (in 1/3 elements)");
    // Nested depth is not expanded beyond level 1.
    expect(output).not.toContain("- x:");
    expect(keyLines(output)).toHaveLength(4);
  });

  test("array key sampling is bounded to 5 keys with a note", async () => {
    const output = await exploreContent({ content: WIDE_ARRAY_CONTENT });
    expect(output).toContain("JSON array: 5 elements");
    expect(output).toContain("- a: number (in 1/5 elements)");
    expect(output).toContain("- e: number (in 1/5 elements)");
    expect(output).toContain("(+5 more keys)");
    expect(output).not.toContain("- f:");
    expect(keyLines(output)).toHaveLength(5);
  });

  test("top-level object: key:type list and total key count, depth 1 only", async () => {
    const output = await exploreContent({ content: JSON_OBJECT_FIXTURE });
    expect(output).toContain("JSON object: 6 keys");
    expect(output).toContain("- name: string");
    expect(output).toContain("- age: number");
    expect(output).toContain("- active: boolean");
    expect(output).toContain("- score: null");
    expect(output).toContain("- tags: array");
    expect(output).toContain("- profile: object");
    // Nested keys are not listed.
    expect(output).not.toContain("city");
    expect(keyLines(output)).toHaveLength(6);
  });

  test("object key listing is bounded to 40 keys", async () => {
    const output = await exploreContent({ content: wideObject(45) });
    expect(output).toContain("JSON object: 45 keys (first 40 shown)");
    const lines = keyLines(output);
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("- key0: number");
    expect(lines[39]).toBe("- key39: number");
    expect(output).not.toContain("- key40:");
  });

  test("malformed JSON degrades to a bounded preview instead of throwing", async () => {
    const malformed = `{"name": "ada", "tags": [1, 2, ${"x".repeat(300)}`;
    const output = await exploreContent({ content: malformed, maxPreview: 40 });
    expect(output.startsWith("Preview: ")).toBe(true);
    expect(output).toContain("…");
    expect(output).toContain('{"name": "ada"');
    expect(output.length).toBeLessThanOrEqual(40 * 2 + 20);
  });
});

describe("exploreContent CSV", () => {
  test("row/column counts, header, sample row, consistency note", async () => {
    const output = await exploreContent({ content: CSV_FIXTURE });
    expect(output).toContain("CSV: 2 data rows, 3 columns");
    expect(output).toContain("Header: id,name,email");
    expect(output).toContain("Sample row: 1, Ada, ada@example.com");
    expect(output).toContain(
      "Consistency: all 2 data rows match the 3-column header",
    );
  });

  test("quoted fields with embedded commas split correctly", async () => {
    const output = await exploreContent({ content: CSV_QUOTED_FIXTURE });
    expect(output).toContain("CSV: 2 data rows, 2 columns");
    expect(output).toContain("Sample row: 1, Doe, Jane");
    expect(output).toContain(
      "Consistency: all 2 data rows match the 2-column header",
    );
  });

  test("ragged rows produce a field-count mismatch note", async () => {
    const output = await exploreContent({ content: CSV_RAGGED_FIXTURE });
    expect(output).toContain("CSV: 3 data rows, 3 columns");
    expect(output).toContain(
      "Consistency: field count mismatch in data rows 1 (2 fields); header has 3",
    );
  });
});

describe("exploreContent SQL", () => {
  test("statement counts by kind and deduped table names", async () => {
    const output = await exploreContent({ content: SQL_FIXTURE });
    expect(output).toContain(
      "SQL statements: 2 create table, 2 insert into, 1 select, 1 update, 1 delete, 1 alter table",
    );
    expect(output).toContain("Tables: users, orders");
  });

  test("table name listing is bounded to 20", async () => {
    const output = await exploreContent({ content: MANY_TABLES });
    expect(output).toContain(
      "SQL statements: 25 create table, 0 insert into, 0 select, 0 update, 0 delete, 0 alter table",
    );
    expect(output).toContain(
      "Tables: t0, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12, t13, t14, t15, t16, t17, t18, t19 (+5 more)",
    );
    expect(output).not.toContain("t20");
  });
});

describe("exploreContent code", () => {
  test("signatures and import/module lines", async () => {
    const output = await exploreContent({ content: CODE_FIXTURE });
    expect(output).toContain("Code signatures (4):");
    expect(output).toContain("- function add(a, b)");
    expect(output).toContain("- class Widget");
    expect(output).toContain("- const handler = (req) =>");
    expect(output).toContain("- const helper = (x) =>");
    expect(output).toContain("Imports/modules (3):");
    expect(output).toContain('- import { readFile } from "node:fs";');
    expect(output).toContain('- import path from "node:path";');
    expect(output).toContain('- const mod = require("node:module");');
  });

  test("signatures and imports are bounded (20 and 10) with notes", async () => {
    const output = await exploreContent({ content: MANY_CODE });
    expect(output).toContain("Code signatures (showing first 20 of 25):");
    expect(output).toContain("- function f0(0)");
    expect(output).toContain("- function f19(19)");
    expect(output).not.toContain("- function f20");
    expect(output).toContain("Imports/modules (showing first 10 of 12):");
    expect(output).toContain('- import mod0 from "pkg0";');
    expect(output).not.toContain("mod10");
    expect(
      output.split("\n").filter((l) => l.startsWith("- function ")),
    ).toHaveLength(20);
    expect(
      output.split("\n").filter((l) => l.startsWith("- import ")),
    ).toHaveLength(10);
  });
});

describe("exploreContent prose", () => {
  test("uses the injected summarizer, called with content and signal", async () => {
    const content = "A long reflection on the nature of compactness and time.";
    const controller = new AbortController();
    const signal = controller.signal;
    const summarize = mock(async (text: string, s: AbortSignal) => {
      expect(text).toBe(content);
      expect(s).toBe(signal);
      return "A crisp summary.";
    });
    const output = await exploreContent({ content, signal, summarize });
    expect(output).toBe("Summary: A crisp summary.");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith(content, signal);
  });

  test("summarizer rejection degrades to a head/tail preview", async () => {
    const summarize = mock(async (_text: string, _signal: AbortSignal) => {
      throw new Error("model unavailable");
    });
    const output = await exploreContent({
      content: LONG_PROSE,
      summarize,
      maxPreview: 30,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(output.startsWith("Preview: ")).toBe(true);
    expect(output).toContain("…");
    // Fragments are chosen to fit inside the 30-char head/tail excerpts.
    expect(output).toContain("Once upon a time there");
    expect(output).toContain("happily ever after");
  });

  test("a signal aborted before the call skips the summarizer and previews", async () => {
    const controller = new AbortController();
    controller.abort();
    const summarize = mock(async () => "never called");
    const output = await exploreContent({
      content: LONG_PROSE,
      signal: controller.signal,
      summarize,
      maxPreview: 30,
    });
    expect(summarize).toHaveBeenCalledTimes(0);
    expect(output.startsWith("Preview: ")).toBe(true);
    expect(output).toContain("…");
    expect(output).toContain("Once upon a time there");
    expect(output).toContain("happily ever after");
  });

  test("an abort during the summarizer call is absorbed into the preview", async () => {
    const controller = new AbortController();
    const summarize = mock(async (_text: string, s: AbortSignal) => {
      controller.abort();
      expect(s.aborted).toBe(true);
      throw new DOMException("Aborted", "AbortError");
    });
    const output = await exploreContent({
      content: LONG_PROSE,
      signal: controller.signal,
      summarize,
      maxPreview: 30,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(output.startsWith("Preview: ")).toBe(true);
    expect(output).toContain("…");
    expect(output).toContain("happily ever after");
  });

  test("missing summarizer degrades to a head/tail preview", async () => {
    const output = await exploreContent({
      content: LONG_PROSE,
      maxPreview: 30,
    });
    expect(output.startsWith("Preview: ")).toBe(true);
    expect(output).toContain("…");
    expect(output).toContain("Once upon a time there");
    expect(output).toContain("happily ever after");
  });
});

describe("exploreContent bounds", () => {
  test("maxOutput caps every path, including long summarizer output", async () => {
    const cases = [
      { options: { content: JSON_ARRAY_FIXTURE }, cap: 120 },
      { options: { content: wideObject(45) }, cap: 120 },
      { options: { content: CSV_FIXTURE }, cap: 120 },
      { options: { content: SQL_FIXTURE }, cap: 120 },
      { options: { content: CODE_FIXTURE }, cap: 120 },
      { options: { content: LONG_PROSE, maxPreview: 400 }, cap: 120 },
      {
        options: {
          content: "short prose",
          summarize: mock(async () => "x".repeat(500)),
        },
        cap: 120,
      },
    ];
    for (const { options, cap } of cases) {
      const output = await exploreContent({ ...options, maxOutput: cap });
      expect(output.length).toBeLessThanOrEqual(cap);
    }
  });

  test("head/tail preview respects maxPreview per side", async () => {
    const output = await exploreContent({
      content: LONG_PROSE,
      maxPreview: 30,
    });
    expect(output.length).toBeLessThanOrEqual(30 * 2 + 20);
    expect(output).toContain("…");
  });
});
