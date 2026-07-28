/** Artifact-backed retrieval tools for the LCM extension. */

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
interface LcmNode {
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
const validId = (v: unknown): v is string =>
  typeof v === "string" && ID_RE.test(v) && v.length <= 32;
function boundedText(value: string, limit: number): string {
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

function asNode(value: unknown): LcmNode | undefined {
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
async function readArtifact(
  resolver: ArtifactResolver,
  id: string,
): Promise<string> {
  const path = await resolver.getArtifactPath(id);
  if (!path || typeof path !== "string")
    throw new Error(`artifact ${artifactUri(id)} was not found`);
  return Bun.file(path).text();
}
const paramsOf = (input: unknown): ExpandParams =>
  input && typeof input === "object" ? (input as ExpandParams) : {};

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
      const params = paramsOf(input);
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
