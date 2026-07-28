import type { LcmPreserveStateV1, LcmRootRef } from "./contracts.ts";
import { LCM_PRESERVE_KEY } from "./contracts.ts";

export interface ContextFullPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  [key: string]: unknown;
}
export interface ContextFullResult {
  summary: string;
  shortSummary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: Record<string, unknown>;
  preserveData: Record<string, unknown>;
}
export interface ContextFullRenderOptions {
  preparation: ContextFullPreparation;
  state: LcmPreserveStateV1;
  roots?: LcmRootRef[];
}

function format(state: LcmPreserveStateV1, roots = state.roots): string {
  const lines = ["## Retained LCM history", ""];
  roots.forEach((root, i) => {
    lines.push(
      `### Root ${i + 1}`,
      root.summary,
      `Expand node: artifact://${root.artifactId}`,
      "",
    );
  });
  lines.push(
    "Retrieval: use `lcm_expand` for node structure, `read artifact://ID` for exact content, and grep/search against artifact URIs for exact matches.",
  );
  return lines.join("\n");
}
export function renderContextFull(
  options: ContextFullRenderOptions,
): ContextFullResult {
  const roots = options.roots ?? options.state.roots;
  const archived = roots.reduce((n, r) => n + r.sourceEntryCount, 0);
  return {
    summary: format(options.state, roots),
    shortSummary: `LCM retained ${roots.length} root${roots.length === 1 ? "" : "s"}; archived ${archived} source entr${archived === 1 ? "y" : "ies"}.`,
    firstKeptEntryId: options.preparation.firstKeptEntryId,
    tokensBefore: options.preparation.tokensBefore,
    details: {
      rootCount: roots.length,
      archivedSourceEntries: archived,
      generation: options.state.generation,
    },
    preserveData: { [LCM_PRESERVE_KEY]: options.state },
  };
}
export const render = renderContextFull;
export const formatLcmRoots = format;
