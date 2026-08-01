import {
  isNumericArtifactId,
  LCM_PRESERVE_KEY,
  RAW_CHUNK_TARGET_TOKENS,
} from "./contracts.ts";

export interface SourceEntry {
  id?: string;
  entryId?: string;
  type?: string;
  [key: string]: unknown;
}
export interface SourcePreparation {
  firstKeptEntryId: string;
  previousPreserveData?: Record<string, unknown>;
  previousSummary?: string;
  messagesToSummarize?: unknown[];
  turnPrefixMessages?: unknown[];
  [key: string]: unknown;
}
export interface SourceEvent {
  branchEntries: SourceEntry[];
  preparation: SourcePreparation;
  signal?: AbortSignal;
  [key: string]: unknown;
}
export type TokenEstimator = (value: string, entry?: SourceEntry) => number;
export type ArtifactSaver = (
  content: string,
  toolType: string,
) => string | Promise<string>;
export interface RawChunk {
  entries: SourceEntry[];
  content: string;
  tokenCount: number;
}
export interface SourceSelection {
  entries: SourceEntry[];
  keepIndex: number;
  startIndex: number;
  endIndex: number;
  priorGeneration?: number;
  priorCompactionIndex?: number;
}
export interface SourceCapture {
  selection: SourceSelection;
  chunks: RawChunk[];
  rawArtifactIds: string[];
}
export class SourceBoundaryError extends Error {
  readonly code = "LCM_SOURCE_BOUNDARY" as const;
  constructor(message = "LCM keep boundary was not found") {
    super(message);
    this.name = "SourceBoundaryError";
  }
}
export class SourceAbortError extends Error {
  readonly code = "LCM_SOURCE_ABORTED" as const;
  constructor() {
    super("LCM source capture aborted");
    this.name = "SourceAbortError";
  }
}
export class SourceCaptureError extends Error {
  readonly code = "LCM_SOURCE_CAPTURE" as const;
  constructor(message: string) {
    super(message);
    this.name = "SourceCaptureError";
  }
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SourceAbortError();
}
function entryId(entry: SourceEntry): string | undefined {
  const id = entry.id ?? entry.entryId;
  return typeof id === "string" ? id : undefined;
}
function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function parsePriorLcmState(
  data: unknown,
): { version: 1; generation: number; roots: unknown[] } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)[LCM_PRESERVE_KEY];
  if (!value || typeof value !== "object") return undefined;
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !validGeneration(state.generation) ||
    !Array.isArray(state.roots) ||
    state.roots.length > 4
  )
    return undefined;
  for (const root of state.roots) {
    if (
      !root ||
      typeof root !== "object" ||
      typeof (root as Record<string, unknown>).artifactId !== "string" ||
      !isNumericArtifactId(
        (root as Record<string, unknown>).artifactId as string,
      )
    )
      return undefined;
  }
  return { version: 1, generation: state.generation, roots: state.roots };
}
function compactionGeneration(entry: SourceEntry): number | undefined {
  const candidates: unknown[] = [
    entry.preserveData,
    (entry.compaction as Record<string, unknown> | undefined)?.preserveData,
    (entry.data as Record<string, unknown> | undefined)?.preserveData,
  ];
  for (const candidate of candidates) {
    const state = parsePriorLcmState(candidate);
    if (state) return state.generation;
  }
  return undefined;
}
function isCompaction(entry: SourceEntry): boolean {
  return (
    entry.type === "compaction" ||
    entry.type === "branch_compaction" ||
    compactionGeneration(entry) !== undefined
  );
}
export function selectSourceEntries(event: SourceEvent): SourceSelection {
  checkAbort(event.signal);
  const entries = event.branchEntries;
  const keepIndex = entries.findIndex(
    (entry) => entryId(entry) === event.preparation.firstKeptEntryId,
  );
  if (keepIndex < 0) throw new SourceBoundaryError();
  const prior = parsePriorLcmState(event.preparation.previousPreserveData);
  let startIndex = 0;
  let priorCompactionIndex: number | undefined;
  if (prior)
    for (let i = keepIndex - 1; i >= 0; i--)
      if (compactionGeneration(entries[i]) === prior.generation) {
        startIndex = i + 1;
        priorCompactionIndex = i;
        break;
      }
  const selected = entries
    .slice(startIndex, keepIndex)
    .filter((entry) => !isCompaction(entry));
  const discardedMessageCount =
    (event.preparation.messagesToSummarize?.length ?? 0) +
    (event.preparation.turnPrefixMessages?.length ?? 0);
  if (
    selected.length === 0 &&
    (keepIndex > startIndex || discardedMessageCount > 0)
  )
    throw new SourceBoundaryError("Discarded source is empty");
  return {
    entries: selected,
    keepIndex,
    startIndex,
    endIndex: keepIndex,
    priorGeneration: prior?.generation,
    priorCompactionIndex,
  };
}
function defaultEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
const OMITTED_SUMMARY_FIELDS: Record<string, true> = {
  encrypted_content: true,
  encryptedContent: true,
  providerPayload: true,
  thinkingSignature: true,
};
const OMITTED_SUMMARY_VALUE =
  "[opaque provider metadata omitted; preserved in raw artifact]";

export function serializeSummaryEntries(entries: SourceEntry[]): string {
  return `${entries
    .map((entry) =>
      JSON.stringify(entry, (key, value) =>
        OMITTED_SUMMARY_FIELDS[key] ? OMITTED_SUMMARY_VALUE : value,
      ),
    )
    .join("\n")}\n`;
}

export function planRawChunks(
  entries: SourceEntry[],
  options: {
    estimateTokens?: TokenEstimator;
    targetTokens?: number;
    contextWindow?: number;
    signal?: AbortSignal;
  } = {},
): RawChunk[] {
  const estimate = options.estimateTokens ?? defaultEstimate;
  let target = options.targetTokens ?? RAW_CHUNK_TARGET_TOKENS;
  if (options.contextWindow && Number.isFinite(options.contextWindow))
    target = Math.min(
      target,
      Math.max(2048, Math.floor(options.contextWindow / 8)),
    );
  target = Math.max(1, Math.floor(target));
  const chunks: RawChunk[] = [];
  let current: SourceEntry[] = [];
  let count = 0;
  for (const entry of entries) {
    checkAbort(options.signal);
    const tokenCount = estimate(JSON.stringify(entry), entry);
    if (current.length > 0 && count + tokenCount > target) {
      chunks.push({
        entries: current,
        content: `${current.map((item) => JSON.stringify(item)).join("\n")}\n`,
        tokenCount: count,
      });
      current = [];
      count = 0;
    }
    current.push(entry);
    count += tokenCount;
  }
  if (current.length)
    chunks.push({
      entries: current,
      content: `${current.map((item) => JSON.stringify(item)).join("\n")}\n`,
      tokenCount: count,
    });
  return chunks;
}
export async function captureRawSource(
  event: SourceEvent,
  saveArtifact?: ArtifactSaver,
  options: {
    estimateTokens?: TokenEstimator;
    targetTokens?: number;
    contextWindow?: number;
  } = {},
): Promise<SourceCapture> {
  checkAbort(event.signal);
  const selection = selectSourceEntries(event);
  const chunks = planRawChunks(selection.entries, {
    ...options,
    signal: event.signal,
  });
  if (!saveArtifact) return { selection, chunks, rawArtifactIds: [] };
  const ids: string[] = [];
  for (const chunk of chunks) {
    checkAbort(event.signal);
    const id = await saveArtifact(chunk.content, "lcm-raw");
    checkAbort(event.signal);
    if (typeof id !== "string" || !/^[0-9]+$/.test(id))
      throw new SourceCaptureError("Artifact saver returned an invalid ID");
    ids.push(id);
  }
  return { selection, chunks, rawArtifactIds: ids };
}
export const selectSource = selectSourceEntries;
export const planChunks = planRawChunks;
export const captureSource = captureRawSource;
