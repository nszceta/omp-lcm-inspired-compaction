import type { RawChunk, SourceEntry } from "./source.ts";
import { serializeSummaryEntries } from "./source.ts";

export interface SummaryBatch {
  input: string;
  chunkIndexes: number[];
  sourceEntryIds: string[];
  entryCount: number;
  estimatedInputTokens: number;
  oversized: boolean;
}

export interface PlanBatchesOptions {
  maxInputTokens: number;
  signal?: AbortSignal;
}

export function planSummaryBatches(
  chunks: readonly RawChunk[],
  options: PlanBatchesOptions,
): SummaryBatch[] {
  if (chunks.length === 0) return [];
  const budget = Math.max(1, Math.floor(options.maxInputTokens));
  const batches: SummaryBatch[] = [];
  let current: SourceEntry[] = [];
  let currentTokens = 0;
  let start = 0;
  const flush = (end: number): void => {
    const entries = current;
    const estimatedInputTokens = currentTokens;
    batches.push({
      input: serializeSummaryEntries(entries),
      chunkIndexes: range(start, end),
      sourceEntryIds: entries.map((entry) =>
        String(entry.id ?? entry.entryId ?? ""),
      ),
      entryCount: entries.length,
      estimatedInputTokens,
      oversized: estimatedInputTokens > budget,
    });
    current = [];
    currentTokens = 0;
  };
  for (let i = 0; i < chunks.length; i++) {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    const chunk = chunks[i];
    if (current.length > 0 && currentTokens + chunk.tokenCount > budget) {
      flush(i);
      start = i;
    }
    current.push(...chunk.entries);
    currentTokens += chunk.tokenCount;
  }
  if (current.length > 0) flush(chunks.length);
  return batches;
}

function range(start: number, end: number): number[] {
  const indexes: number[] = [];
  for (let i = start; i < end; i++) indexes.push(i);
  return indexes;
}
