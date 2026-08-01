/** Artifact-backed retrieval tools for the LCM extension. */

import { complete as completeModel } from "@oh-my-pi/pi-ai";
import { LCM_PRESERVE_KEY, parseLcmPreserveState } from "./contracts.ts";
import { exploreContent } from "./explore.ts";
import type { SourceEntry } from "./source.ts";

export interface ArtifactResolver {
  getArtifactPath(
    id: string,
  ): string | undefined | null | Promise<string | undefined | null>;
}
export interface ExpandToolContext {
  sessionManager?: ArtifactResolver;
  [key: string]: unknown;
}
export interface ExpandParams {
  artifactId?: unknown;
  depth?: unknown;
  includeRaw?: unknown;
}
export interface ExpandRenderOptions {
  summaryLimit?: number;
  singleLineSummaries?: boolean;
}
export interface LcmNode {
  schema: "omp-lcm-node/v1";
  kind: string;
  level: number;
  summary: string;
  children: string[];
  rawSources: string[];
  sourceEntryCount?: number;
}
const MAX_DEPTH = 8;
const MAX_NODES = 48;
const MAX_OUTPUT = 12_000;
const MAX_RAW_PREVIEW = 1_500;
const ID_RE = /^[0-9]+$/;
const artifactUri = (id: string) => `artifact://${id}`;
export const validId = (v: unknown): v is string =>
  typeof v === "string" && ID_RE.test(v) && v.length <= 32;
export function boundedText(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 40))}\n[… output truncated; use read artifact://ID:<range> …]`;
}
function summaryPreview(value: string, options: ExpandRenderOptions): string {
  const text = options.singleLineSummaries
    ? value.replace(/\s+/gu, " ").trim()
    : value;
  const limit = options.summaryLimit ?? 2_000;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function asNode(value: unknown): LcmNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.schema !== "omp-lcm-node/v1" ||
    typeof v.kind !== "string" ||
    typeof v.level !== "number" ||
    !Number.isFinite(v.level) ||
    typeof v.summary !== "string" ||
    !Array.isArray(v.children) ||
    !Array.isArray(v.rawSources)
  )
    return undefined;
  const children = v.children.filter(validId),
    rawSources = v.rawSources.filter(validId);
  if (
    children.length !== v.children.length ||
    rawSources.length !== v.rawSources.length
  )
    return undefined;
  return {
    schema: "omp-lcm-node/v1",
    kind: v.kind,
    level: v.level,
    summary: v.summary,
    children,
    rawSources,
    sourceEntryCount:
      typeof v.sourceEntryCount === "number" ? v.sourceEntryCount : undefined,
  };
}
export async function readArtifact(
  resolver: ArtifactResolver,
  id: string,
): Promise<string> {
  const path = await resolver.getArtifactPath(id);
  if (!path || typeof path !== "string")
    throw new Error(`artifact ${artifactUri(id)} was not found`);
  return Bun.file(path).text();
}
const paramsOf = <T>(input: unknown): T =>
  input && typeof input === "object" ? (input as T) : ({} as T);

/** Creates a registration-compatible handler; all failures become tool text. */
export function createLcmExpandHandler(
  getContext?: (context: unknown) => ExpandToolContext | undefined,
  renderOptions: ExpandRenderOptions = {},
) {
  return async function lcmExpandHandler(
    input: unknown,
    context?: unknown,
  ): Promise<string> {
    try {
      const params = paramsOf<ExpandParams>(input);
      const rawContext = getContext
        ? getContext(context)
        : (context as ExpandToolContext | undefined);
      const ctx =
        rawContext &&
        typeof (rawContext as unknown as ArtifactResolver).getArtifactPath ===
          "function"
          ? { sessionManager: rawContext as unknown as ArtifactResolver }
          : rawContext;
      const resolver = ctx?.sessionManager;
      if (!resolver || typeof resolver.getArtifactPath !== "function")
        return "lcm_expand error: artifact resolver unavailable";
      if (!validId(params.artifactId))
        return "lcm_expand error: artifactId must be a numeric string";
      const depthValue = params.depth === undefined ? 1 : Number(params.depth);
      if (!Number.isInteger(depthValue) || depthValue < 0)
        return "lcm_expand error: depth must be a non-negative integer";
      const depth = Math.min(depthValue, MAX_DEPTH),
        includeRaw = params.includeRaw === true,
        seen = new Set<string>();
      let visited = 0;
      const lines: string[] = [];
      let size = 0;
      const append = (line: string) => {
        if (size < MAX_OUTPUT) {
          lines.push(line);
          size += line.length + 1;
        }
      };
      const visit = async (id: string, level: number): Promise<void> => {
        if (visited++ >= MAX_NODES) {
          append("… node limit reached; use lcm_expand on a child artifact …");
          return;
        }
        const indent = "  ".repeat(level);
        if (seen.has(id)) {
          append(`${indent}- ${artifactUri(id)} (cycle detected)`);
          return;
        }
        seen.add(id);
        let text: string;
        try {
          text = await readArtifact(resolver, id);
        } catch (error) {
          append(
            `${indent}- ${artifactUri(id)} (missing: ${error instanceof Error ? error.message : "unreadable"})`,
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        const node = asNode(parsed);
        if (!node) {
          append(`${indent}- ${artifactUri(id)} (malformed lcm node)`);
          return;
        }
        append(
          `${indent}Node ${artifactUri(id)} [${node.kind}, level ${node.level}]${node.sourceEntryCount === undefined ? "" : ` (${node.sourceEntryCount} source entries)`}`,
        );
        append(
          `${indent}Summary: ${summaryPreview(node.summary, renderOptions)}`,
        );
        if (node.rawSources.length)
          append(
            `${indent}Raw sources: ${node.rawSources.map(artifactUri).join(", ")}`,
          );
        if (node.children.length)
          append(
            `${indent}Children: ${node.children.map(artifactUri).join(", ")}`,
          );
        if (includeRaw)
          for (const rawId of node.rawSources.slice(0, 8)) {
            try {
              append(
                `${indent}Raw ${artifactUri(rawId)} preview:\n${boundedText(await readArtifact(resolver, rawId), MAX_RAW_PREVIEW)}`,
              );
            } catch {
              append(`${indent}Raw ${artifactUri(rawId)} (missing)`);
            }
          }
        if (level >= depth) {
          if (node.children.length)
            append(`${indent}(depth limit; expand a child with lcm_expand)`);
          return;
        }
        for (const child of node.children) await visit(child, level + 1);
      };
      await visit(params.artifactId, 0);
      append(
        "Exact content: use read artifact://ID or read artifact://ID:<range>; search with grep against artifact URIs.",
      );
      return boundedText(lines.join("\n"), MAX_OUTPUT);
    } catch (error) {
      return `lcm_expand error: ${error instanceof Error ? error.message : "unexpected artifact failure"}`;
    }
  };
}

export const lcmExpandTool = {
  name: "lcm_expand",
  label: "LCM Expand",
  description: "Traverse an LCM summary node and its artifact links.",
  parameters: {
    type: "object",
    properties: {
      artifactId: { type: "string", description: "Numeric node artifact ID" },
      depth: { type: "integer", minimum: 0, maximum: MAX_DEPTH, default: 1 },
      includeRaw: { type: "boolean", default: false },
    },
    required: ["artifactId"],
    additionalProperties: false,
  },
};
export function registerLcmExpandTool(
  registerToolOrApi:
    | { registerTool: (definition: unknown) => unknown }
    | ((definition: unknown) => unknown),
  fallbackContext?: unknown,
): unknown {
  const registerTool =
    typeof registerToolOrApi === "function"
      ? registerToolOrApi
      : registerToolOrApi.registerTool.bind(registerToolOrApi);
  const handler = createLcmExpandHandler(
    (runtimeContext) =>
      (runtimeContext as ExpandToolContext | undefined) ??
      (fallbackContext as ExpandToolContext | undefined),
  );
  return registerTool({
    ...lcmExpandTool,
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      runtimeContext: unknown,
    ) {
      const text = await handler(params, runtimeContext);
      return { content: [{ type: "text", text }] };
    },
  });
}
export const lcmExpandHandler = createLcmExpandHandler();
export const createLcmExpandTool = createLcmExpandHandler;

/** One visited node from {@link walkLcmNodes}. */
export interface WalkedLcmNode {
  id: string;
  node: LcmNode;
  level: number;
}

export interface WalkLcmOptions {
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * Bounded DAG walk shared with lcm_grep: depth 8, at most 48 nodes, cycle
 * defense via a seen-set — the same caps as lcm_expand. Unreadable or
 * malformed nodes are skipped defensively.
 */
export async function walkLcmNodes(
  resolver: ArtifactResolver,
  rootIds: readonly string[],
  options: WalkLcmOptions = {},
): Promise<WalkedLcmNode[]> {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxNodes = options.maxNodes ?? MAX_NODES;
  const seen = new Set<string>();
  const out: WalkedLcmNode[] = [];
  let visited = 0;
  const visit = async (id: string, level: number): Promise<void> => {
    if (visited >= maxNodes || seen.has(id)) return;
    seen.add(id);
    visited++;
    let text: string;
    try {
      text = await readArtifact(resolver, id);
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const node = asNode(parsed);
    if (!node) return;
    out.push({ id, node, level });
    if (level >= maxDepth) return;
    for (const child of node.children) await visit(child, level + 1);
  };
  for (const rootId of rootIds) await visit(rootId, 0);
  return out;
}

/** Shared context shape for the lcm_describe handler. */
export interface DescribeToolContext extends ExpandToolContext {
  model?: unknown;
  modelRegistry?: {
    getApiKey?: (
      model: unknown,
      sessionId?: string,
      options?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
  };
  sessionManager?: ArtifactResolver & {
    getSessionId?: () => string | undefined;
  };
}

export interface DescribeParams {
  artifactId?: unknown;
  explore?: unknown;
}

export interface DescribeRenderOptions {
  /** Injectable prose summarizer; defaults to a context-built model call. */
  summarize?: (text: string, signal: AbortSignal) => Promise<string>;
  maxOutput?: number;
  maxPreview?: number;
}

const DESCRIBE_DEFAULT_PREVIEW = 2_000;
const DESCRIBE_SUMMARY_PROMPT =
  "Summarize this spilled tool result artifact factually and concisely. " +
  "Preserve key facts, names, numbers, and structure; do not invent details. " +
  "Keep the summary under 300 words.\n\n";

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function tokenEstimate(chars: number): string {
  return `~${Math.max(1, Math.ceil(chars / 4))} tokens (chars / 4)`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function headTailPreview(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit);
  const tail = value.slice(-limit);
  if (head.length + tail.length >= value.length) return value;
  return `${head}…${tail}`;
}

/** True when every non-empty line is a standalone JSON document. */
function isJsonl(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

function completionText(response: unknown): string {
  if (typeof response === "string" && response.trim()) return response.trim();
  if (!response || typeof response !== "object")
    throw new Error("Summary completion returned no message");
  if ("text" in response && typeof response.text === "string") {
    const text = response.text.trim();
    if (text) return text;
  }
  if ("content" in response && Array.isArray(response.content)) {
    const text = response.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string",
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  throw new Error("Summary completion returned no message");
}

/**
 * Builds the prose summarizer from the runtime context (model + registry).
 * Returns undefined when no model context is available, so the caller
 * degrades to a plain preview.
 */
function buildContextSummarizer(
  ctx: DescribeToolContext | undefined,
): ((text: string, signal: AbortSignal) => Promise<string>) | undefined {
  const model = ctx?.model;
  const registry = ctx?.modelRegistry;
  if (!model || typeof registry?.getApiKey !== "function") return undefined;
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  return async (text, signal) => {
    const apiKey = await registry.getApiKey?.(model, sessionId, { signal });
    if (typeof apiKey !== "string" || apiKey === "")
      throw new Error("no API key available for model summarization");
    const context = {
      systemPrompt: [DESCRIBE_SUMMARY_PROMPT],
      messages: [
        { role: "user" as const, content: text, timestamp: Date.now() },
      ],
    };
    const response = await completeModel(
      model as Parameters<typeof completeModel>[0],
      context as Parameters<typeof completeModel>[1],
      {
        apiKey,
        maxTokens: 1_500,
        signal,
      } as Parameters<typeof completeModel>[2],
    );
    return completionText(response);
  };
}

/** Creates a registration-compatible handler; all failures become tool text. */
export function createLcmDescribeHandler(
  getContext?: (context: unknown) => DescribeToolContext | undefined,
  options: DescribeRenderOptions = {},
) {
  return async function lcmDescribeHandler(
    input: unknown,
    context?: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const params = paramsOf<DescribeParams>(input);
      const rawContext = getContext
        ? getContext(context)
        : (context as DescribeToolContext | undefined);
      const resolver = rawContext?.sessionManager;
      if (!resolver || typeof resolver.getArtifactPath !== "function")
        return "lcm_describe error: artifact resolver unavailable";
      if (!validId(params.artifactId))
        return "lcm_describe error: artifactId must be a numeric string";
      const explore = params.explore === true;
      const maxOutput = positiveInt(options.maxOutput, MAX_OUTPUT);
      const maxPreview = positiveInt(
        options.maxPreview,
        DESCRIBE_DEFAULT_PREVIEW,
      );
      let text: string;
      try {
        text = await readArtifact(resolver, params.artifactId);
      } catch (error) {
        return `lcm_describe error: ${error instanceof Error ? error.message : "artifact could not be read"}`;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const node = parsed === undefined ? undefined : asNode(parsed);
      if (node) {
        const lines = [
          `Node ${artifactUri(params.artifactId)} [${node.kind}, level ${node.level}]`,
        ];
        if (node.children.length > 0)
          lines.push(`Children: ${node.children.map(artifactUri).join(", ")}`);
        if (node.rawSources.length > 0)
          lines.push(
            `Raw sources: ${node.rawSources.map(artifactUri).join(", ")}`,
          );
        if (node.sourceEntryCount !== undefined)
          lines.push(`Source entries: ${node.sourceEntryCount}`);
        lines.push(`Token estimate: ${tokenEstimate(text.length)}`);
        lines.push("Summary:", node.summary);
        return boundedText(lines.join("\n"), maxOutput);
      }
      if (parsed !== undefined && asNode(parsed) === undefined) {
        const looksLikeNode =
          !!parsed &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).schema === "omp-lcm-node/v1";
        if (looksLikeNode)
          return `lcm_describe error: artifact ${artifactUri(params.artifactId)} is a malformed lcm node`;
      }
      if (parsed === undefined && isJsonl(text)) {
        const entries = text
          .split("\n")
          .filter((line) => line.trim() !== "").length;
        return boundedText(
          [
            `Raw ${artifactUri(params.artifactId)}`,
            `Entries: ${entries}`,
            `Size: ${byteLength(text)} bytes`,
            `Token estimate: ${tokenEstimate(text.length)}`,
            `Preview: ${headTailPreview(text, maxPreview)}`,
          ].join("\n"),
          maxOutput,
        );
      }
      const meta = [
        `Artifact ${artifactUri(params.artifactId)}`,
        `Size: ${byteLength(text)} bytes`,
        `Lines: ${text.split("\n").filter((line) => line.trim() !== "").length}`,
      ];
      if (!explore) return meta.join("\n");
      const summarize = options.summarize ?? buildContextSummarizer(rawContext);
      const exploration = await exploreContent({
        content: text,
        signal,
        summarize,
        maxOutput,
        maxPreview,
      });
      return boundedText(
        `${meta.join("\n")}\nExploration:\n${exploration}`,
        maxOutput,
      );
    } catch (error) {
      return `lcm_describe error: ${error instanceof Error ? error.message : "unexpected artifact failure"}`;
    }
  };
}

export const lcmDescribeTool = {
  name: "lcm_describe",
  label: "LCM Describe",
  description:
    "Describe an LCM artifact: summary node metadata, raw chunk stats, or explored spilled tool results.",
  parameters: {
    type: "object",
    properties: {
      artifactId: {
        type: "string",
        description: "Numeric artifact ID to describe",
      },
      explore: {
        type: "boolean",
        default: false,
        description: "Run content exploration on non-LCM artifacts",
      },
    },
    required: ["artifactId"],
    additionalProperties: false,
  },
};
export function registerLcmDescribeTool(
  registerToolOrApi:
    | { registerTool: (definition: unknown) => unknown }
    | ((definition: unknown) => unknown),
  fallbackContext?: unknown,
): unknown {
  const registerTool =
    typeof registerToolOrApi === "function"
      ? registerToolOrApi
      : registerToolOrApi.registerTool.bind(registerToolOrApi);
  const handler = createLcmDescribeHandler(
    (runtimeContext) =>
      (runtimeContext as DescribeToolContext | undefined) ??
      (fallbackContext as DescribeToolContext | undefined),
  );
  return registerTool({
    ...lcmDescribeTool,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      runtimeContext: unknown,
    ) {
      const text = await handler(params, runtimeContext, signal);
      return { content: [{ type: "text", text }] };
    },
  });
}
export const lcmDescribeHandler = createLcmDescribeHandler();
export const createLcmDescribeTool = createLcmDescribeHandler;

/** Shared context shape for the lcm_grep handler. */
export interface GrepToolContext extends ExpandToolContext {
  sessionManager?: ArtifactResolver & {
    getEntries?: () =>
      | unknown[]
      | readonly unknown[]
      | undefined
      | null
      | Promise<unknown[] | readonly unknown[] | undefined | null>;
    getBranch?: () =>
      | unknown[]
      | readonly unknown[]
      | undefined
      | null
      | Promise<unknown[] | readonly unknown[] | undefined | null>;
  };
}

export interface GrepParams {
  pattern?: unknown;
  summaryId?: unknown;
  limit?: unknown;
  caseSensitive?: unknown;
}

const MAX_SCAN_BYTES = 256 * 1024;
const GREP_DEFAULT_LIMIT = 50;
const GREP_MAX_LIMIT = 200;
const GREP_PREVIEW = 500;

/**
 * Scan session entries backward for the latest compaction entry carrying
 * parseable LCM preserve data; resume-safe (latest wins) like source.ts.
 */
function lcmRootsFromEntries(
  entries: readonly SourceEntry[],
): string[] | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") continue;
    const candidates: unknown[] = [
      entry.preserveData,
      (entry.compaction as Record<string, unknown> | undefined)?.preserveData,
      (entry.data as Record<string, unknown> | undefined)?.preserveData,
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const state = parseLcmPreserveState(
        (candidate as Record<string, unknown>)[LCM_PRESERVE_KEY],
      );
      if (state) return state.roots.map((root) => root.artifactId);
    }
  }
  return undefined;
}

async function resolveBranchEntries(
  sessionManager: NonNullable<GrepToolContext["sessionManager"]>,
): Promise<SourceEntry[] | undefined> {
  const methods = ["getEntries", "getBranch"] as const;
  for (const method of methods) {
    const fn = sessionManager[method];
    if (typeof fn !== "function") continue;
    try {
      const result = await fn();
      if (Array.isArray(result)) return result as SourceEntry[];
    } catch {
      // Defensive: fall through to the next entry source.
    }
  }
  return undefined;
}

function matchPreview(line: string, regex: RegExp): string {
  regex.lastIndex = 0;
  const match = regex.exec(line);
  if (match === null || match.index === undefined) {
    return line.length <= GREP_PREVIEW
      ? line
      : `${line.slice(0, GREP_PREVIEW - 1)}…`;
  }
  const max = GREP_PREVIEW;
  const center = match.index;
  const start = Math.max(0, center - Math.floor(max / 2));
  let end = Math.min(line.length, start + max);
  if (end - start === max) {
    if (start > 0 && end < line.length) end -= 2;
    else if (start > 0 || end < line.length) end -= 1;
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.length ? "…" : "";
  return `${prefix}${line.slice(start, end)}${suffix}`;
}

/** Creates a registration-compatible handler; all failures become tool text. */
export function createLcmGrepHandler(
  getContext?: (context: unknown) => GrepToolContext | undefined,
) {
  return async function lcmGrepHandler(
    input: unknown,
    context?: unknown,
    _signal?: AbortSignal,
  ): Promise<string> {
    try {
      const params = paramsOf<GrepParams>(input);
      const rawContext = getContext
        ? getContext(context)
        : (context as GrepToolContext | undefined);
      const sessionManager = rawContext?.sessionManager;
      if (
        !sessionManager ||
        typeof sessionManager.getArtifactPath !== "function"
      )
        return "lcm_grep error: artifact resolver unavailable";
      if (typeof params.pattern !== "string" || params.pattern === "")
        return "lcm_grep error: pattern must be a non-empty string";
      let limit =
        params.limit === undefined ? GREP_DEFAULT_LIMIT : Number(params.limit);
      if (!Number.isInteger(limit)) limit = GREP_DEFAULT_LIMIT;
      limit = Math.min(GREP_MAX_LIMIT, Math.max(1, limit));
      const caseSensitive = params.caseSensitive === true;
      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, caseSensitive ? "u" : "iu");
      } catch (error) {
        return `lcm_grep error: invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
      }
      let roots: string[] | undefined;
      if (params.summaryId !== undefined) {
        if (!validId(params.summaryId))
          return "lcm_grep error: summaryId must be a numeric string";
        try {
          const text = await readArtifact(sessionManager, params.summaryId);
          if (asNode(JSON.parse(text)) === undefined)
            return `lcm_grep error: artifact ${artifactUri(params.summaryId)} is not an lcm node`;
        } catch (error) {
          return `lcm_grep error: ${error instanceof Error ? error.message : "summary artifact could not be read"}`;
        }
        roots = [params.summaryId];
      } else {
        const entries = await resolveBranchEntries(sessionManager);
        if (entries) roots = lcmRootsFromEntries(entries);
        if (!roots || roots.length === 0)
          return "lcm_grep error: no LCM history found (no compaction entry with ompLcmArtifactsV1 preserve data); pass summaryId to search a specific node";
      }
      const visited = await walkLcmNodes(sessionManager, roots);
      if (visited.length === 0)
        return `lcm_grep error: no reachable lcm nodes under ${roots.map(artifactUri).join(", ")}`;
      let totalMatches = 0;
      const rendered: Array<{
        node: WalkedLcmNode;
        raw: string;
        line: number;
        preview: string;
      }> = [];
      const partialRaws: string[] = [];
      const missingRaws: string[] = [];
      const seenRaws = new Set<string>();
      for (const visitedNode of visited) {
        for (const rawId of visitedNode.node.rawSources) {
          if (seenRaws.has(rawId)) continue;
          seenRaws.add(rawId);
          let content: string;
          let partial = false;
          try {
            const path = await sessionManager.getArtifactPath(rawId);
            if (typeof path !== "string" || path === "") {
              missingRaws.push(rawId);
              continue;
            }
            const file = Bun.file(path);
            const size = file.size;
            partial = typeof size === "number" && size > MAX_SCAN_BYTES;
            content = partial
              ? await file.slice(0, MAX_SCAN_BYTES).text()
              : await file.text();
          } catch {
            missingRaws.push(rawId);
            continue;
          }
          if (partial) partialRaws.push(rawId);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              totalMatches++;
              if (totalMatches <= limit) {
                rendered.push({
                  node: visitedNode,
                  raw: rawId,
                  line: i + 1,
                  preview: matchPreview(lines[i], regex),
                });
              }
            }
          }
        }
      }
      const out: string[] = [
        `lcm_grep /${params.pattern}/ under ${roots.map(artifactUri).join(", ")} (case-sensitive: ${caseSensitive ? "yes" : "no"})`,
      ];
      if (totalMatches === 0) {
        out.push(
          `No matches in ${visited.length} node(s), ${seenRaws.size} raw artifact(s)`,
        );
      } else {
        let currentNodeId: string | undefined;
        for (const entry of rendered) {
          if (entry.node.id !== currentNodeId) {
            currentNodeId = entry.node.id;
            out.push(
              `Node ${artifactUri(entry.node.id)} [${entry.node.node.kind}, level ${entry.node.node.level}]:`,
            );
          }
          out.push(`${artifactUri(entry.raw)}:${entry.line}: ${entry.preview}`);
        }
      }
      for (const rawId of partialRaws) {
        out.push(
          `(partial scan) ${artifactUri(rawId)} exceeds 256 KiB; only the first 256 KiB were scanned`,
        );
      }
      for (const rawId of missingRaws) {
        out.push(`(missing) ${artifactUri(rawId)} could not be read`);
      }
      if (totalMatches > limit) {
        out.push(
          `… truncated: showing ${limit} of ${totalMatches} matches; use a narrower pattern or a larger limit …`,
        );
      }
      let output = out.join("\n");
      if (output.length > MAX_OUTPUT) {
        output = `${output.slice(0, Math.max(0, MAX_OUTPUT - 90))}\n… grep output truncated at ${MAX_OUTPUT} characters; use a narrower pattern or a smaller limit …`;
      }
      return output;
    } catch (error) {
      return `lcm_grep error: ${error instanceof Error ? error.message : "unexpected artifact failure"}`;
    }
  };
}

export const lcmGrepTool = {
  name: "lcm_grep",
  label: "LCM Grep",
  description:
    "Regex-search raw artifacts reachable from the latest LCM summary roots.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search for",
      },
      summaryId: {
        type: "string",
        description:
          "Numeric node artifact ID to search from instead of the latest roots",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: GREP_MAX_LIMIT,
        default: GREP_DEFAULT_LIMIT,
        description: "Maximum number of matches to show",
      },
      caseSensitive: { type: "boolean", default: false },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};
export function registerLcmGrepTool(
  registerToolOrApi:
    | { registerTool: (definition: unknown) => unknown }
    | ((definition: unknown) => unknown),
  fallbackContext?: unknown,
): unknown {
  const registerTool =
    typeof registerToolOrApi === "function"
      ? registerToolOrApi
      : registerToolOrApi.registerTool.bind(registerToolOrApi);
  const handler = createLcmGrepHandler(
    (runtimeContext) =>
      (runtimeContext as GrepToolContext | undefined) ??
      (fallbackContext as GrepToolContext | undefined),
  );
  return registerTool({
    ...lcmGrepTool,
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      runtimeContext: unknown,
    ) {
      const text = await handler(params, runtimeContext);
      return { content: [{ type: "text", text }] };
    },
  });
}
export const lcmGrepHandler = createLcmGrepHandler();
export const createLcmGrepTool = createLcmGrepHandler;
