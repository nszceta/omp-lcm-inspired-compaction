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

const DEFAULT_COUNT: TokenCounter = (text) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
};

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

function boundedDeterministic(
  input: string,
  target: number,
  count: TokenCounter,
): string {
  const limit = Math.max(1, Math.floor(target));
  const prefix = "Archived source (deterministic fallback): ";
  const words = input.trim() ? input.trim().split(/\s+/u) : [];
  // Build by token count rather than character count; this guarantees the result
  // remains bounded for counters used by the host and by tests.
  const prose = prefix;
  if (count(prose) > limit)
    return prefix.split(/\s+/u).slice(0, limit).join(" ");
  const room = Math.max(0, limit - count(prose));
  if (words.length <= room) return prose + words.join(" ");
  if (room <= 2) return prose + words.slice(0, room).join(" ");
  const head = Math.ceil(room / 2);
  const tail = room - head - 1;
  return (
    prose +
    words.slice(0, head).join(" ") +
    " … " +
    words.slice(-Math.max(0, tail)).join(" ")
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
  const retrieval =
    count(RETRIEVAL_WORDING) <= target
      ? RETRIEVAL_WORDING
      : RETRIEVAL_WORDING.split(/\s+/u).slice(0, target).join(" ");
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
      if (prose && total <= target && total < inputTokens) {
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
