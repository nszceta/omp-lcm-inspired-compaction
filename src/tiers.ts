export type SummaryModelTier = "tiny" | "smol" | "active";

export interface TierModelInfo {
  model: unknown; // the OMP Model object
  provider: string;
  id: string;
  label: string; // `${provider}/${id}` — recorded in status
  contextWindow?: number; // model.contextWindow if finite positive number
}

export interface TierResolverDeps {
  models?: {
    resolve?: (spec: string) => unknown; // ExtensionModelQuery.resolve
    list?: () => unknown[];
    current?: () => unknown;
  };
  modelRegistry?: {
    getApiKey?: (
      model: unknown,
      sessionId?: string,
      options?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    hasConfiguredAuth?: (model: unknown) => boolean;
  };
  sessionId?: string;
}

export interface ResolvedSummaryModel {
  role: SummaryModelTier; // the tier that actually resolved
  model: TierModelInfo;
  apiKey: string;
  label: string;
}

export interface ResolveTierOptions {
  signal?: AbortSignal;
  activeModel?: unknown; // ctx.model; required for the "active" tier
  minContextWindow?: number; // models with a smaller contextWindow are ineligible
}

export const TIER_CHAINS: Record<"leaf" | "root", readonly SummaryModelTier[]> =
  {
    leaf: ["tiny", "smol", "active"],
    root: ["smol", "active", "tiny"],
  };

/**
 * Put the configured preferred tier first, then the remaining canonical tiers
 * in their original order. The setting selects the starting point of the
 * fallback chain; it never removes tiers from it.
 */
export function preferredChain(
  preferred: SummaryModelTier,
  base: readonly SummaryModelTier[],
): SummaryModelTier[] {
  return [preferred, ...base.filter((tier) => tier !== preferred)];
}

export const SUMMARY_RESERVE_TOKENS = 8_000; // prompt + output reserve
export const MIN_VIABLE_BATCH_TOKENS = 2_048; // budget floor below which a tier is not worth a call

export function batchBudgetFor(
  configuredMax: number,
  contextWindow: number | undefined,
  reserveTokens: number = SUMMARY_RESERVE_TOKENS,
): number {
  if (contextWindow === undefined || !Number.isFinite(contextWindow)) {
    return configuredMax;
  }
  return Math.max(
    1,
    Math.min(configuredMax, Math.floor(contextWindow - reserveTokens)),
  );
}

interface CandidateModelShape {
  provider?: string;
  id?: string;
  contextWindow?: number;
  textCapable: boolean;
}

/**
 * Narrow an opaque OMP Model candidate to the fields the resolver relies on.
 * contextWindow is kept only when it is a finite positive number; input is
 * accepted when absent/empty or an array containing "text".
 */
function candidateModelShape(candidate: object): CandidateModelShape {
  const provider = "provider" in candidate ? candidate.provider : undefined;
  const id = "id" in candidate ? candidate.id : undefined;
  const input = "input" in candidate ? candidate.input : undefined;
  const contextWindow =
    "contextWindow" in candidate ? candidate.contextWindow : undefined;
  const emptyInput =
    input === undefined ||
    input === null ||
    input === "" ||
    (Array.isArray(input) && input.length === 0);
  return {
    provider: typeof provider === "string" ? provider : undefined,
    id: typeof id === "string" ? id : undefined,
    contextWindow:
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > 0
        ? contextWindow
        : undefined,
    textCapable: emptyInput || (Array.isArray(input) && input.includes("text")),
  };
}

export async function resolveSummaryModel(
  chain: readonly SummaryModelTier[],
  deps: TierResolverDeps,
  options: ResolveTierOptions = {},
): Promise<ResolvedSummaryModel | undefined> {
  for (const role of chain) {
    let candidate: unknown;
    if (role === "active") {
      candidate = options.activeModel;
      if (!candidate) continue;
    } else {
      const resolve = deps.models?.resolve;
      if (!resolve) continue;
      // The @ prefix is REQUIRED: getModelRoleAlias only recognizes prefixed
      // aliases; a bare role name would be treated as a literal model id.
      candidate = resolve(`@${role}`);
      if (!candidate) continue;
    }

    // Candidate must be an object and text-capable.
    if (typeof candidate !== "object" || candidate === null) continue;
    const shape = candidateModelShape(candidate);
    if (!shape.textCapable) continue;

    // A finite positive contextWindow must satisfy the minimum, when provided.
    if (
      options.minContextWindow !== undefined &&
      shape.contextWindow !== undefined &&
      shape.contextWindow < options.minContextWindow
    ) {
      continue;
    }

    // Credentials must resolve for the candidate model itself.
    const apiKey = await deps.modelRegistry?.getApiKey?.(
      candidate,
      deps.sessionId,
      {
        signal: options.signal,
      },
    );
    if (!apiKey) continue;

    const provider = shape.provider ?? "unknown";
    const id = shape.id ?? "unknown";
    const label = `${provider}/${id}`;
    const model: TierModelInfo = {
      model: candidate,
      provider,
      id,
      label,
      ...(shape.contextWindow !== undefined
        ? { contextWindow: shape.contextWindow }
        : {}),
    };
    return { role, model, apiKey, label };
  }
  return undefined;
}
