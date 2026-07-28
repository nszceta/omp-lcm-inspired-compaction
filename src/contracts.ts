export const PLUGIN_NAME = "omp-lcm-inspired-compaction" as const;
export const LCM_PRESERVE_KEY = "ompLcmArtifactsV1" as const;
export const MAX_ACTIVE_ROOTS = 4 as const;
export const RAW_CHUNK_TARGET_TOKENS = 12_000 as const;
export const ROOT_SUMMARY_TARGET_TOKENS = 2_048 as const;
export const SNAPCOMPACT_MAX_FRAMES = 4 as const;

export type LcmRenderer = "auto" | "context-full" | "snapcompact";
export type Renderer = LcmRenderer;

export interface LcmRootRef {
  artifactId: string;
  level: number;
  summary: string;
  sourceEntryCount: number;
  tokenCount: number;
}

export interface LcmPreserveStateV1 {
  version: 1;
  generation: number;
  roots: LcmRootRef[];
}

export interface LcmNodeArtifactV1 {
  schema: "omp-lcm-node/v1";
  kind: "leaf-summary" | "condensed-summary" | "legacy-summary";
  level: number;
  summary: string;
  children: string[];
  rawSources: string[];
  sourceEntryIds: string[];
  sourceEntryCount: number;
  createdAt: string;
}

const MAX_GENERATION = 1_000_000_000;
const MAX_COUNT = 1_000_000_000;
const MAX_SUMMARY_LENGTH = 1_000_000;

function isSafeCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNT
  );
}
function isSafeLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_GENERATION
  );
}

/** Session artifact IDs are decimal, positive, canonical numeric strings. */
export function isNumericArtifactId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return false;
  const number = Number(value);
  return (
    Number.isSafeInteger(number) &&
    number >= 1 &&
    number <= Number.MAX_SAFE_INTEGER
  );
}

export function formatArtifactUri(value: unknown): string | undefined {
  return isNumericArtifactId(value) ? `artifact://${value}` : undefined;
}
export const artifactUri = formatArtifactUri;

function parseRoot(value: unknown): LcmRootRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const root = value as Record<string, unknown>;
  if (
    !isNumericArtifactId(root.artifactId) ||
    !isSafeLevel(root.level) ||
    typeof root.summary !== "string" ||
    root.summary.length > MAX_SUMMARY_LENGTH ||
    !isSafeCount(root.sourceEntryCount) ||
    !isSafeCount(root.tokenCount)
  )
    return undefined;
  return {
    artifactId: root.artifactId,
    level: root.level,
    summary: root.summary,
    sourceEntryCount: root.sourceEntryCount,
    tokenCount: root.tokenCount,
  };
}

/** Invalid or hostile session preserve data is treated as absent, never thrown. */
export function parseLcmPreserveState(
  value: unknown,
): LcmPreserveStateV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.generation) ||
    (state.generation as number) < 0 ||
    (state.generation as number) > MAX_GENERATION ||
    !Array.isArray(state.roots) ||
    state.roots.length > MAX_ACTIVE_ROOTS
  )
    return undefined;
  const roots: LcmRootRef[] = [];
  for (const item of state.roots) {
    const root = parseRoot(item);
    if (!root) return undefined;
    roots.push(root);
  }
  return { version: 1, generation: state.generation as number, roots };
}

export const parsePreserveState = parseLcmPreserveState;
export const parseLcmState = parseLcmPreserveState;
export const isNumericId = isNumericArtifactId;
export const formatArtifactId = formatArtifactUri;
export const parseRendererSetting = parseRenderer;

export function parseRenderer(value: unknown): LcmRenderer | undefined {
  return value === "auto" || value === "context-full" || value === "snapcompact"
    ? value
    : undefined;
}

/** Deterministic model-visible rendering of active roots. */
export function formatRoots(roots: readonly LcmRootRef[]): string {
  const sections = ["## Retained LCM history", ""];
  roots.forEach((root, index) => {
    sections.push(
      `### Root ${index + 1}`,
      root.summary,
      `Expand node: artifact://${root.artifactId}`,
      "",
    );
  });
  sections.push(
    "Retrieval: use `lcm_expand` for node structure, `read artifact://ID` for exact content, and grep/search against artifact URIs for exact matches.",
  );
  return sections.join("\n");
}
export const formatRootSummary = formatRoots;
export const formatLcmRoots = formatRoots;
