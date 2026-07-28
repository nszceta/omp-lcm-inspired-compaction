import { compact as publicCompact } from "@oh-my-pi/snapcompact";
import type { LcmPreserveStateV1 } from "./contracts.ts";
import { formatRoots, LCM_PRESERVE_KEY } from "./contracts.ts";
export interface SnapPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  fileOps?: unknown;
  [key: string]: unknown;
}
export interface SnapModel {
  input?: string[];
  inputTypes?: string[];
  supportsVision?: boolean;
  [key: string]: unknown;
}
export interface SnapRenderOptions {
  preparation: SnapPreparation;
  state: LcmPreserveStateV1;
  model: SnapModel;
  signal?: AbortSignal;
  compact?: (...args: any[]) => Promise<any> | any;
}
export class NonVisionModelError extends Error {
  constructor() {
    super("snapcompact requires a vision-capable model");
    this.name = "NonVisionModelError";
  }
}
const vision = (model: SnapModel) => {
  if (model.supportsVision === true) return true;
  const types = model.input ?? model.inputTypes ?? [];
  return (
    Array.isArray(types) &&
    types.some((x) => String(x).toLowerCase() === "image")
  );
};
const synthetic = (summary: string) => ({
  role: "user",
  content: [{ type: "text", text: summary }],
});
export async function renderSnapcompact(
  options: SnapRenderOptions,
): Promise<any> {
  if (!vision(options.model)) throw new NonVisionModelError();
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const prep: any = {
    ...options.preparation,
    messagesToSummarize: [synthetic(formatRoots(options.state.roots))],
    turnPrefixMessages: [],
    recentMessages: [],
    previousSummary: undefined,
    previousPreserveData: { [LCM_PRESERVE_KEY]: options.state },
  };
  const fn: any = options.compact ?? publicCompact;
  const result = await fn(prep, options.model, {
    maxFrames: 4,
    signal: options.signal,
  });
  if (!result || typeof result !== "object")
    throw new Error("snapcompact returned an invalid result");
  return {
    ...result,
    preserveData: { [LCM_PRESERVE_KEY]: options.state },
  };
}
export const render = renderSnapcompact;
