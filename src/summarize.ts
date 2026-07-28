export const RETRIEVAL_WORDING =
  "Retrieval: use `lcm_expand` for node structure, `read artifact://ID` for exact content, and grep/search against artifact URIs for exact matches.";

export interface SummaryRequest {
  /** Conversational text to summarize. */
  input: string;
  /** Maximum estimated tokens for the complete model-visible summary. */
  targetTokens: number;
  /** Optional label used to make the requested summary categories explicit. */
  category?: string;
  /** Abort signal for the complete operation. */
  signal?: AbortSignal;
}

/** The injected model seam. Implementations must return prose only (no IDs or links). */
export type SummaryCall = (request: SummaryModelRequest) => Promise<string>;

export interface SummaryModelRequest {
  prompt: string;
  input: string;
  targetTokens: number;
  signal: AbortSignal;
  level: "normal" | "aggressive";
}

export type TokenCounter = (text: string) => number;

export interface SummaryResult {
  /** Model/deterministic prose, intentionally separate from retrieval wording. */
  prose: string;
  /** Deterministic text appended by callers when rendering active context. */
  retrieval: string;
  level: "normal" | "aggressive" | "deterministic";
  tokenCount: number;
}

const DEFAULT_COUNT: TokenCounter = (text) => Math.ceil(text.length / 4);

const CATEGORY_PROMPT = [
  "Summarize the source faithfully and concisely.",
  "Cover goals and user intent; decisions and rationale; files, symbols, commands, and observed results;",
  "errors, blockers, and unresolved risks; current state and next actions; and facts needed to continue accurately.",
  "Return summary prose only. Do not emit artifact IDs, links, or retrieval instructions.",
].join(" ");

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    // Preserve the platform's abort semantics and, importantly, do not fall back.
    throw (
      signal.reason ??
      new DOMException("The summary operation was aborted", "AbortError")
    );
  }
}

export function boundedByTokens(
  input: string,
  target: number,
  count: TokenCounter,
): string {
  const text = input.trim();
  const limit = Math.max(0, Math.floor(target));
  if (!text || limit === 0) return "";
  if (count(text) <= limit) return text;
  const suffix = " …";
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, middle).trimEnd()}${suffix}`;
    if (count(candidate) <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function boundedDeterministic(
  input: string,
  target: number,
  count: TokenCounter,
): string {
  return boundedByTokens(
    `Archived source (deterministic fallback): ${input.trim()}`,
    target,
    count,
  );
}

function modelPrompt(
  level: "normal" | "aggressive",
  category?: string,
): string {
  const mode =
    level === "normal" ? "Preserve useful detail" : "Be especially terse";
  return `${CATEGORY_PROMPT} ${mode}.${category ? ` Summary category: ${category}.` : ""}`;
}

/**
 * Run normal, aggressive, then deterministic convergence. Retrieval text is
 * never sent as model prose and is measured as part of the active-context bound.
 */
export async function summarizeText(
  request: SummaryRequest,
  call: SummaryCall,
  count: TokenCounter = DEFAULT_COUNT,
): Promise<SummaryResult> {
  const signal = request.signal ?? new AbortController().signal;
  const target = Math.max(1, Math.floor(request.targetTokens));
  const inputTokens = count(request.input);
  const retrieval = boundedByTokens(
    RETRIEVAL_WORDING,
    Math.floor(target / 4),
    count,
  );
  const retrievalTokens = count(retrieval);
  const candidateTarget = Math.max(1, target - retrievalTokens);

  for (const level of ["normal", "aggressive"] as const) {
    checkAbort(signal);
    const levelTarget =
      level === "normal"
        ? candidateTarget
        : Math.max(1, Math.floor(candidateTarget / 2));
    try {
      const prose = (
        await call({
          prompt: modelPrompt(level, request.category),
          input: request.input,
          targetTokens: levelTarget,
          signal,
          level,
        })
      ).trim();
      checkAbort(signal);
      const total = count(prose) + retrievalTokens;
      if (prose && total <= target && count(prose) < inputTokens) {
        return { prose, retrieval, level, tokenCount: total };
      }
    } catch {
      checkAbort(signal);
      // A failed level is ordinary convergence failure; try the next level.
    }
  }

  checkAbort(signal);
  const prose =
    candidateTarget > 0
      ? boundedDeterministic(request.input, candidateTarget, count)
      : "";
  const tokenCount = count(prose) + retrievalTokens;
  return { prose, retrieval, level: "deterministic", tokenCount };
}

export const convergeSummary = summarizeText;
export const summarize = summarizeText;
