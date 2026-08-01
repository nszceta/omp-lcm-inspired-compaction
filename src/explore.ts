export type ContentKind = "json" | "csv" | "sql" | "code" | "prose";

export interface ExploreOptions {
  content: string;
  signal?: AbortSignal;
  /**
   * Model prose summarizer for prose content. When absent/undefined, or when
   * it rejects or the signal aborts, prose degrades to a bounded head/tail
   * preview.
   */
  summarize?: (text: string, signal: AbortSignal) => Promise<string>;
  /** Total output cap in characters (default 8_000). */
  maxOutput?: number;
  /** Per-excerpt cap for any single head/tail preview (default 2_000). */
  maxPreview?: number;
}

const DEFAULT_MAX_OUTPUT = 8_000;
const DEFAULT_MAX_PREVIEW = 2_000;
const NEVER_ABORTED = new AbortController().signal;

const SQL_DETECT =
  /(create\s+table|insert\s+into|select\s+.*\s+from|alter\s+table)/i;
const TABLE_NAME =
  /(?:create\s+table|insert\s+into|update|alter\s+table)\s+(["`]?[a-z0-9_.]+)/gi;
const FUNCTION_SIGNATURE =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
const CLASS_SIGNATURE = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/;
const ARROW_SIGNATURE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/;

/** Deep value type: primitives via typeof; null, arrays, and objects summarized. */
function deepType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  return typeof value;
}

/**
 * Quote-aware CSV field splitter (state machine, no dependencies). Splits on
 * commas or tabs; `"…"` quoting with `""` escapes is honored.
 */
function splitCsvFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === "," || ch === "\t") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Non-empty content lines, trailing whitespace stripped. */
function nonEmptyLines(content: string): string[] {
  const lines: string[] = [];
  for (const raw of content.split("\n")) {
    if (raw.trim() !== "") {
      lines.push(raw.trimEnd());
    }
  }
  return lines;
}

/** Head + "…" + tail, each side at most maxPreview characters. */
function headTailPreview(content: string, maxPreview: number): string {
  if (content.length <= maxPreview) {
    return content;
  }
  const head = content.slice(0, maxPreview);
  const tail = content.slice(-maxPreview);
  if (head.length + tail.length >= content.length) {
    return content;
  }
  return `${head}…${tail}`;
}

function excerptLimit(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/**
 * Classify content: JSON when it parses, CSV when at least two lines share the
 * first line's field count, SQL on statement keywords, code on code signals,
 * otherwise prose.
 */
export function detectKind(content: string): ContentKind {
  const trimmed = content.trim();
  try {
    void JSON.parse(trimmed);
    return "json";
  } catch {
    // Not JSON; try the structural detectors below.
  }
  const lines = nonEmptyLines(content);
  if (lines.length >= 2) {
    const firstFieldCount = splitCsvFields(lines[0]).length;
    if (firstFieldCount >= 2) {
      let matching = 1;
      for (let i = 1; i < lines.length; i++) {
        if (splitCsvFields(lines[i]).length === firstFieldCount) {
          matching++;
        }
      }
      if (matching >= 2) {
        return "csv";
      }
    }
  }
  if (SQL_DETECT.test(content)) {
    return "sql";
  }
  if (
    content.includes("function ") ||
    content.includes("class ") ||
    content.includes("=>") ||
    content.includes("def ") ||
    content.includes("import ") ||
    content.includes("#include") ||
    (content.includes("{") && content.includes("}"))
  ) {
    return "code";
  }
  return "prose";
}

function describeJsonArray(value: unknown[]): string {
  const lines = [`JSON array: ${value.length} elements`];
  const sampleCount = Math.min(5, value.length);
  const sampleKeys: Array<{ key: string; type: string }> = [];
  const seen = new Set<string>();
  const totalKeys = new Set<string>();
  for (let i = 0; i < sampleCount; i++) {
    const element = value[i];
    if (
      element === null ||
      typeof element !== "object" ||
      Array.isArray(element)
    ) {
      continue;
    }
    const record = element as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      totalKeys.add(key);
      if (sampleKeys.length < 5 && !seen.has(key)) {
        seen.add(key);
        sampleKeys.push({ key, type: deepType(record[key]) });
      }
    }
  }
  if (sampleKeys.length > 0) {
    lines.push(`Keys (sampled from first ${sampleCount} elements):`);
    for (const { key, type } of sampleKeys) {
      let present = 0;
      for (const element of value) {
        if (
          element !== null &&
          typeof element === "object" &&
          !Array.isArray(element) &&
          Object.hasOwn(element, key)
        ) {
          present++;
        }
      }
      lines.push(`- ${key}: ${type} (in ${present}/${value.length} elements)`);
    }
    const extra = totalKeys.size - sampleKeys.length;
    if (extra > 0) {
      lines.push(`(+${extra} more keys)`);
    }
  }
  return lines.join("\n");
}

function describeJsonObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  const limit = 40;
  const shown = keys.slice(0, limit);
  const lines = [
    keys.length > limit
      ? `JSON object: ${keys.length} keys (first ${limit} shown)`
      : `JSON object: ${keys.length} keys`,
  ];
  for (const key of shown) {
    lines.push(`- ${key}: ${deepType(value[key])}`);
  }
  return lines.join("\n");
}

function exploreJson(content: string, maxPreview: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Malformed JSON degrades to a bounded head/tail preview.
    return `Preview (JSON parse failed): ${headTailPreview(content, maxPreview)}`;
  }
  if (Array.isArray(parsed)) {
    return describeJsonArray(parsed);
  }
  if (parsed !== null && typeof parsed === "object") {
    return describeJsonObject(parsed as Record<string, unknown>);
  }
  return `JSON value: ${deepType(parsed)}`;
}

function exploreCsv(content: string): string {
  const lines = nonEmptyLines(content);
  const header = lines[0] ?? "";
  const dataRows = lines.slice(1);
  const columnCount = splitCsvFields(header).length;
  const out = [
    `CSV: ${dataRows.length} data rows, ${columnCount} columns`,
    `Header: ${header}`,
  ];
  const firstRow = dataRows[0];
  if (firstRow !== undefined) {
    out.push(`Sample row: ${splitCsvFields(firstRow).join(", ")}`);
  }
  const mismatches: number[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    if (splitCsvFields(dataRows[i]).length !== columnCount) {
      mismatches.push(i + 1);
    }
  }
  if (mismatches.length === 0) {
    out.push(
      `Consistency: all ${dataRows.length} data rows match the ${columnCount}-column header`,
    );
  } else {
    const detail = mismatches
      .slice(0, 5)
      .map(
        (row) => `${row} (${splitCsvFields(dataRows[row - 1]).length} fields)`,
      )
      .join(", ");
    const extra =
      mismatches.length > 5 ? ` (+${mismatches.length - 5} more)` : "";
    out.push(
      `Consistency: field count mismatch in data rows ${detail}; header has ${columnCount}${extra}`,
    );
  }
  return out.join("\n");
}

function exploreSql(content: string): string {
  const kinds: Array<[string, number]> = [
    ["create table", (content.match(/\bcreate\s+table\b/gi) ?? []).length],
    ["insert into", (content.match(/\binsert\s+into\b/gi) ?? []).length],
    ["select", (content.match(/\bselect\b/gi) ?? []).length],
    ["update", (content.match(/\bupdate\b/gi) ?? []).length],
    ["delete", (content.match(/\bdelete\b/gi) ?? []).length],
    ["alter table", (content.match(/\balter\s+table\b/gi) ?? []).length],
  ];
  const lines = [
    `SQL statements: ${kinds.map(([kind, count]) => `${count} ${kind}`).join(", ")}`,
  ];
  const seen: string[] = [];
  const allDistinct = new Set<string>();
  for (const match of content.matchAll(TABLE_NAME)) {
    const name = match[1] ?? "";
    if (name === "") {
      continue;
    }
    allDistinct.add(name);
    if (seen.length < 20 && !seen.includes(name)) {
      seen.push(name);
    }
  }
  if (seen.length > 0) {
    const extra = allDistinct.size - seen.length;
    lines.push(
      `Tables: ${seen.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`,
    );
  } else {
    lines.push("Tables: none");
  }
  return lines.join("\n");
}

function signatureOf(line: string): string | undefined {
  const fn = line.match(FUNCTION_SIGNATURE);
  if (fn !== null) {
    return `function ${fn[1]}(${fn[2].trim()})`;
  }
  const cls = line.match(CLASS_SIGNATURE);
  if (cls !== null) {
    return `class ${cls[1]}`;
  }
  const arrow = line.match(ARROW_SIGNATURE);
  if (arrow !== null) {
    const params = (arrow[2] ?? arrow[3] ?? "").trim();
    return `const ${arrow[1]} = (${params}) =>`;
  }
  return undefined;
}

function isImportLine(line: string): boolean {
  if (/^\s*import\b/.test(line)) {
    return true;
  }
  if (/\brequire\(/.test(line)) {
    return true;
  }
  return /^\s*export\b/.test(line) && /\bfrom\b/.test(line);
}

function exploreCode(content: string): string {
  let totalSignatures = 0;
  let totalImports = 0;
  const signatures: string[] = [];
  const imports: string[] = [];
  for (const line of content.split("\n")) {
    const signature = signatureOf(line);
    if (signature !== undefined) {
      totalSignatures++;
      if (signatures.length < 20) {
        signatures.push(signature);
      }
    }
    if (isImportLine(line)) {
      totalImports++;
      if (imports.length < 10) {
        imports.push(line.trim());
      }
    }
  }
  const out: string[] = [];
  if (signatures.length > 0) {
    out.push(
      totalSignatures > 20
        ? `Code signatures (showing first 20 of ${totalSignatures}):`
        : `Code signatures (${totalSignatures}):`,
    );
    out.push(...signatures.map((signature) => `- ${signature}`));
  }
  if (imports.length > 0) {
    out.push(
      totalImports > 10
        ? `Imports/modules (showing first 10 of ${totalImports}):`
        : `Imports/modules (${totalImports}):`,
    );
    out.push(...imports.map((line) => `- ${line}`));
  }
  if (out.length === 0) {
    return "Code: no signatures or imports found";
  }
  return out.join("\n");
}

async function exploreProse(
  options: ExploreOptions,
  maxPreview: number,
): Promise<string> {
  const signal = options.signal ?? NEVER_ABORTED;
  if (signal.aborted || options.summarize === undefined) {
    return `Preview: ${headTailPreview(options.content, maxPreview)}`;
  }
  try {
    const summary = await options.summarize(options.content, signal);
    return `Summary: ${summary}`;
  } catch {
    // Rejection or abort of the summarizer degrades to the bounded preview.
    return `Preview: ${headTailPreview(options.content, maxPreview)}`;
  }
}

function exploreStructured(
  kind: ContentKind,
  content: string,
  maxPreview: number,
): string {
  switch (kind) {
    case "json":
      return exploreJson(content, maxPreview);
    case "csv":
      return exploreCsv(content);
    case "sql":
      return exploreSql(content);
    case "code":
      return exploreCode(content);
    default:
      return ""; // prose is handled by exploreContent
  }
}

/**
 * Explore content by kind. All output is bounded by maxOutput; content issues
 * never throw and an aborted signal degrades to the bounded preview.
 */
export async function exploreContent(options: ExploreOptions): Promise<string> {
  const maxOutput = excerptLimit(options.maxOutput, DEFAULT_MAX_OUTPUT);
  const maxPreview = excerptLimit(options.maxPreview, DEFAULT_MAX_PREVIEW);
  const kind = detectKind(options.content);
  let output: string;
  if (kind === "prose") {
    output = await exploreProse(options, maxPreview);
  } else {
    output = exploreStructured(kind, options.content, maxPreview);
  }
  return output.slice(0, maxOutput);
}
