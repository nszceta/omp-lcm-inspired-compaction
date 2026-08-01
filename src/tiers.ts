import { type ApiKeyResolver, resolveApiKeyOnce } from "@oh-my-pi/pi-ai";

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
    /** Registry auth-retry resolver; preferred over a getApiKey snapshot. */
    resolver?: (model: unknown, sessionId?: string) => ApiKeyResolver;
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

export interface TierCandidateObservation {
  role: SummaryModelTier;
  label: string; // "provider/id", or "(none)" when no candidate model exists
  ok: boolean;
  reason: "no-candidate" | "not-text" | "context-too-small" | "no-key" | "ok";
}

export interface ResolveTierOptions {
  signal?: AbortSignal;
  activeModel?: unknown; // ctx.model; required for the "active" tier
  minContextWindow?: number; // models with a smaller contextWindow are ineligible
  /** Called once per chain step with the candidate verdict (diagnostics). */
  onCandidate?: (observation: TierCandidateObservation) => void;
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
  const emit = (
    role: SummaryModelTier,
    observation: Omit<TierCandidateObservation, "role">,
  ) => {
    options.onCandidate?.({ role, ...observation });
  };
  for (const role of chain) {
    let candidate: unknown;
    if (role === "active") {
      candidate = options.activeModel;
      if (!candidate) {
        emit(role, { label: "(none)", ok: false, reason: "no-candidate" });
        continue;
      }
    } else {
      const resolve = deps.models?.resolve;
      if (!resolve) {
        emit(role, { label: "(none)", ok: false, reason: "no-candidate" });
        continue;
      }
      // The @ prefix is REQUIRED: getModelRoleAlias only recognizes prefixed
      // aliases; a bare role name would be treated as a literal model id.
      candidate = resolve(`@${role}`);
      if (!candidate) {
        emit(role, { label: "(none)", ok: false, reason: "no-candidate" });
        continue;
      }
    }

    // Candidate must be an object and text-capable.
    if (typeof candidate !== "object" || candidate === null) {
      emit(role, { label: "(none)", ok: false, reason: "no-candidate" });
      continue;
    }
    const shape = candidateModelShape(candidate);
    const label = `${shape.provider ?? "unknown"}/${shape.id ?? "unknown"}`;
    if (!shape.textCapable) {
      emit(role, { label, ok: false, reason: "not-text" });
      continue;
    }

    // A finite positive contextWindow must satisfy the minimum, when provided.
    if (
      options.minContextWindow !== undefined &&
      shape.contextWindow !== undefined &&
      shape.contextWindow < options.minContextWindow
    ) {
      emit(role, { label, ok: false, reason: "context-too-small" });
      continue;
    }

    // Credentials must resolve for the candidate model itself. Prefer the
    // registry's auth-retry resolver so the gate and the summary call share
    // one credential machinery (GAP-006 consistency; the call path seeds from
    // this same snapshot). Bare getApiKey registries keep the snapshot gate.
    const registry = deps.modelRegistry;
    const apiKey = registry?.resolver
      ? await resolveApiKeyOnce(
          registry.resolver(candidate, deps.sessionId),
          options.signal,
        )
      : await registry?.getApiKey?.(candidate, deps.sessionId, {
          signal: options.signal,
        });
    // kNoAuth ("N/A") is the pi-coding-agent registry's keyless-provider
    // sentinel (model-registry.ts `export const kNoAuth = "N/A"`); it is not
    // a usable credential. Compared literally to avoid a runtime coupling to
    // the peer package for one constant.
    if (!apiKey || apiKey === "N/A") {
      emit(role, { label, ok: false, reason: "no-key" });
      continue;
    }

    const model: TierModelInfo = {
      model: candidate,
      provider: shape.provider ?? "unknown",
      id: shape.id ?? "unknown",
      label,
      ...(shape.contextWindow !== undefined
        ? { contextWindow: shape.contextWindow }
        : {}),
    };
    emit(role, { label, ok: true, reason: "ok" });
    return { role, model, apiKey, label };
  }
  return undefined;
}
