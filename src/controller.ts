import {
  ThinkingLevel,
  type ThinkingLevel as ThinkingLevelValue,
} from "@oh-my-pi/pi-agent-core";
import {
  buildOpenAiNativeHistory,
  type CompactionPreparation,
  defaultConvertToLlm,
  getCompactionV2Endpoint,
  getCompactionV2PreserveData,
  getPreservedOpenAiRemoteCompactionData,
  compact as runOmpCompaction,
  SUMMARIZATION_SYSTEM_PROMPT,
  shouldUseCompactionV2Streaming,
  shouldUseOpenAiRemoteCompaction,
  withOpenAiRemoteCompactionPreserveData,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
  type ApiKey,
  type ApiKeyResolver,
  complete as completeModel,
  seedApiKeyResolver,
  withAuth,
} from "@oh-my-pi/pi-ai";
import { planSummaryBatches, type SummaryBatch } from "./batch.ts";
import {
  configFromSettings,
  type LcmConfig,
  type Renderer,
  readConfig,
} from "./config.ts";
import { parseLcmPreserveState } from "./contracts.ts";
import { buildDag } from "./dag.ts";
import { Deadline, raceWithSignal } from "./deadline.ts";
import { countOrphanArtifacts, orphanStoreFor } from "./orphans.ts";
import { runBoundedPool } from "./pool.ts";
import { renderContextFull } from "./render-context-full.ts";
import {
  NonVisionModelError,
  renderSnapcompact,
} from "./render-snapcompact.ts";
import {
  createNativeReplayLineage,
  NATIVE_REPLAY_LINEAGE_KEY,
  type NativeReplayLineageV1,
  nativeReplayLineagesMatch,
  parseNativeReplayLineage,
  type ReplayModel,
  replayCredentialIdentity,
} from "./replay-lineage.ts";
import { captureRawSource } from "./source.ts";
import type {
  SummaryCall,
  SummaryModelRequest,
  SummaryRequest,
  SummaryResult,
} from "./summarize.ts";
import { deterministicSummary, summarizeText } from "./summarize.ts";
import {
  batchBudgetFor,
  MIN_VIABLE_BATCH_TOKENS,
  preferredChain,
  type ResolvedSummaryModel,
  resolveSummaryModel,
  SUMMARY_RESERVE_TOKENS,
  TIER_CHAINS,
  type TierCandidateObservation,
  type TierResolverDeps,
} from "./tiers.ts";

type RequestNativeCompaction =
  typeof import("@oh-my-pi/pi-agent-core/compaction").requestOpenAiRemoteCompaction;

export interface LcmRuntimeStatus {
  lastRenderer?: "context-full" | "snapcompact";
  lastGeneration?: number;
  lastRootCount?: number;
  lastRoots?: Array<{
    artifactId: string;
    level: number;
    sourceEntryCount: number;
    tokenCount: number;
  }>;
  lastRawArtifactCount?: number;
  lastOrphanArtifactCount?: number;
  lastSourceEntryCount?: number;
  lastTokensBefore?: number;
  lastFirstKeptEntryId?: string;
  lastSummaryPreview?: string;
  lastPreserveKeys?: string[];
  lastSnapcompactFrameCount?: number;
  builtInRemoteContextFullIntercepted?: boolean;
  lastOutcome?: "running" | "success" | "cancelled" | "error";
  lastSummaryQuality?: "model" | "deterministic-fallback";
  lastDeterministicFallbackCount?: number;
  lastNativeReplayStatus?:
    | "preserved"
    | "disabled"
    | "ineligible"
    | "unavailable"
    | "empty"
    | "failed";
  lastNativeReplayProvider?: string;
  lastNativeReplayItemCount?: number;
  lastNativeReplaySeeded?: boolean;
  lastNativeReplayError?: string;
  lastStartedAt?: string;
  lastElapsedMs?: number;
  lastLeafSummaryModel?: string;
  lastRootSummaryModel?: string;
  lastRawChunkCount?: number;
  lastSummaryBatchCount?: number;
  lastSummaryConcurrency?: number;
  lastCompletedModelSummaryCount?: number;
  lastDeadlineFallbackCount?: number;
  lastDeadlineStage?: "leaf" | "root" | "native-replay" | "total";
  lastLeafModelError?: string;
  lastRootModelError?: string;
  lastTierRejections?: string[];
  lastError?: string;
}
export interface LcmController {
  beforeCompact: (event: any) => Promise<any>;
  status: LcmRuntimeStatus;
}

export type CompletionCall = (
  model: unknown,
  context: {
    systemPrompt: string[];
    messages: Array<{ role: "user"; content: string; timestamp: number }>;
  },
  options: {
    apiKey: ApiKey | undefined;
    maxTokens: number;
    signal: AbortSignal;
  },
) => Promise<unknown>;

export interface ControllerDeps {
  capture?: typeof captureRawSource;
  summarize?: typeof summarizeText;
  dag?: typeof buildDag;
  context?: any;
  summaryCall?: SummaryCall;
  complete?: CompletionCall;
  nativeCompact?: typeof runOmpCompaction;
  requestNativeCompaction?: RequestNativeCompaction;
  notify?: (message: string) => void;
  log?: (message: string) => void;
  status?: LcmRuntimeStatus;
  getPluginSettings?: (name: string, cwd?: string) => unknown;
  config?: Partial<LcmConfig>; // merged over readConfig (test seam; bypasses bounds)
  resolveTier?: typeof resolveSummaryModel; // default: the real resolver from ./tiers.ts
}

/**
 * Structural slice of the OMP model registry the credential resolver needs.
 * The real host registry (ModelRegistry) exposes `resolver(model, sessionId)`
 * implementing the central a/b/c auth-retry policy; older or fake registries
 * degrade to a refresh-aware `getApiKey` wrapper.
 */
interface RegistryKeySource {
  resolver?: (model: unknown, sessionId?: string) => ApiKeyResolver;
  authStorage?: {
    resolver?: (
      provider: string,
      options?: { sessionId?: string; baseUrl?: string; modelId?: string },
    ) => ApiKeyResolver;
  };
  getApiKey?: (
    model: unknown,
    sessionId?: string,
    options?: { forceRefresh?: boolean; signal?: AbortSignal },
  ) => Promise<string | undefined>;
}

/**
 * Build the credential source for summary model calls, preferring the host's
 * own auth-retry policy (initial resolve, force-refresh on 401, sibling
 * rotation on 403/usage-limit) and degrading to a refresh-aware getApiKey
 * wrapper for registries that only expose key snapshots.
 */
function registryApiKeyResolver(
  registry: RegistryKeySource | undefined,
  model: unknown,
  sessionId: string | undefined,
): ApiKeyResolver | undefined {
  if (typeof registry?.resolver === "function") {
    return registry.resolver(model, sessionId) as ApiKeyResolver;
  }
  const storage = registry?.authStorage;
  if (typeof storage?.resolver === "function") {
    const candidate = model as {
      provider?: string;
      baseUrl?: string;
      id?: string;
    };
    return storage.resolver(candidate.provider ?? "unknown", {
      sessionId,
      baseUrl: candidate.baseUrl,
      modelId: candidate.id,
    });
  }
  if (typeof registry?.getApiKey === "function") {
    const getApiKey = registry.getApiKey;
    const getKey = (options: {
      forceRefresh?: boolean;
      signal?: AbortSignal;
    }) => getApiKey(model, sessionId, options);
    return async (ctx) => {
      // No rotation primitive on a bare registry: force-refresh on any auth
      // failure so a stale OAuth bearer is re-minted instead of replayed.
      return getKey({
        forceRefresh: ctx.error !== undefined,
        signal: ctx.signal,
      });
    };
  }
  return undefined;
}

function recordModelCallError(
  status: LcmRuntimeStatus,
  stage: "leaf" | "root",
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const truncated = message.slice(0, 300);
  if (stage === "leaf") status.lastLeafModelError = truncated;
  else status.lastRootModelError = truncated;
}

interface StatusPersistenceContext {
  sessionManager?: {
    appendCustomEntry?: (customType: string, data?: unknown) => unknown;
  };
}

/**
 * Persist the run's diagnostics as a session custom entry so `/lcm status`
 * survives extension reloads (GAP-027). Best-effort: persistence must never
 * fail or slow the compaction, and the entry carries no secrets (bounded
 * error text, model labels, counts).
 */
function persistRuntimeStatus(
  ctx: StatusPersistenceContext | undefined,
  status: LcmRuntimeStatus,
): void {
  try {
    const manager = ctx?.sessionManager;
    if (typeof manager?.appendCustomEntry !== "function") return;
    manager.appendCustomEntry("lcm-status", {
      version: 1,
      persistedAt: new Date().toISOString(),
      // Copy: the session writer may serialize asynchronously, and the live
      // object is mutated by the next run.
      status: { ...status },
    });
  } catch {
    // Best-effort diagnostics; never fail compaction over persistence.
  }
}

function completionText(response: unknown): string {
  if (typeof response === "string" && response.trim()) return response.trim();
  if (!response || typeof response !== "object")
    throw new Error("Summary completion returned no message");
  if ("text" in response && typeof response.text === "string") {
    const text = response.text.trim();
    if (text) return text;
  }
  if ("content" in response && Array.isArray(response.content)) {
    const text = response.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string",
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  throw new Error("Summary completion returned no text content");
}

function notify(deps: ControllerDeps, text: string) {
  deps.notify?.(text);
  deps.log?.(text);
}

/** True when an error is the plugin's own deadline abort (see src/deadline.ts). */
function isDeadlineAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "AbortError" &&
    (error as Error & { reason?: unknown }).reason === "lcm-deadline"
  );
}

function boundedPreview(value: unknown, maxLength = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function frameCount(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const preserveData = (value as Record<string, unknown>).preserveData;
  if (!preserveData || typeof preserveData !== "object") return undefined;
  const archive = (preserveData as Record<string, unknown>).snapcompact;
  if (!archive || typeof archive !== "object") return undefined;
  const frames = (archive as Record<string, unknown>).frames;
  return Array.isArray(frames) ? frames.length : undefined;
}
function modelVision(model: any): boolean {
  return (
    model?.supportsVision === true ||
    (Array.isArray(model?.input) &&
      model.input.some((x: unknown) => String(x).toLowerCase() === "image")) ||
    (Array.isArray(model?.inputTypes) &&
      model.inputTypes.some(
        (x: unknown) => String(x).toLowerCase() === "image",
      ))
  );
}

interface NativeReplayCredentialContext {
  model: ReplayModel & {
    provider: string;
    id: string;
    baseUrl?: string;
  };
  sessionManager?: { getSessionId?: () => string };
  modelRegistry?: {
    getApiKey?: (
      model: unknown,
      sessionId?: string,
      options?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    authStorage?: {
      getOAuthAccess?: (
        provider: string,
        sessionId?: string,
        options?: {
          baseUrl?: string;
          modelId?: string;
          signal?: AbortSignal;
        },
      ) => Promise<
        | {
            accessToken: string;
            credentialId?: number;
            accountId?: string;
            orgId?: string;
            projectId?: string;
            email?: string;
            enterpriseUrl?: string;
            apiEndpoint?: string;
          }
        | undefined
      >;
    };
  };
}

async function resolveNativeReplayCredential(
  ctx: NativeReplayCredentialContext,
  signal?: AbortSignal,
): Promise<{ apiKey: string; identity: string } | undefined> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const apiKey = await ctx.modelRegistry?.getApiKey?.(ctx.model, sessionId, {
    signal,
  });
  if (!apiKey) return undefined;

  const oauthAccess = await ctx.modelRegistry?.authStorage?.getOAuthAccess?.(
    ctx.model.provider,
    sessionId,
    {
      baseUrl: ctx.model.baseUrl,
      modelId: ctx.model.id,
      signal,
    },
  );
  if (oauthAccess?.accessToken === apiKey) {
    const stableParts = [
      oauthAccess.credentialId,
      oauthAccess.accountId,
      oauthAccess.orgId,
      oauthAccess.projectId,
      oauthAccess.email,
      oauthAccess.enterpriseUrl,
      oauthAccess.apiEndpoint,
    ].filter((value) => value !== undefined && value !== null && value !== "");
    const identity =
      stableParts.length > 0
        ? stableParts.map(String).join("\0")
        : oauthAccess.accessToken;
    return {
      apiKey,
      identity: replayCredentialIdentity("oauth", identity),
    };
  }
  return {
    apiKey,
    identity: replayCredentialIdentity("api-key", apiKey),
  };
}

type NativeReplayMechanism = "v1" | "v2";

function selectNativeReplayMechanism(
  model: any,
  settings: { remoteStreamingV2Enabled?: boolean },
): NativeReplayMechanism | undefined {
  if (
    settings.remoteStreamingV2Enabled !== false &&
    shouldUseCompactionV2Streaming(model)
  )
    return "v2";
  return shouldUseOpenAiRemoteCompaction(model) ? "v1" : undefined;
}

function activeThinkingLevel(
  entries: readonly unknown[],
): ThinkingLevelValue | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      !entry ||
      typeof entry !== "object" ||
      !("type" in entry) ||
      entry.type !== "thinking_level_change" ||
      !("thinkingLevel" in entry)
    )
      continue;
    switch (entry.thinkingLevel) {
      case ThinkingLevel.Off:
        return ThinkingLevel.Off;
      case ThinkingLevel.Minimal:
        return ThinkingLevel.Minimal;
      case ThinkingLevel.Low:
        return ThinkingLevel.Low;
      case ThinkingLevel.Medium:
        return ThinkingLevel.Medium;
      case ThinkingLevel.High:
        return ThinkingLevel.High;
      case ThinkingLevel.XHigh:
        return ThinkingLevel.XHigh;
      case ThinkingLevel.Max:
        return ThinkingLevel.Max;
      default:
        return undefined;
    }
  }
  return undefined;
}

function withoutNativeReplayPreserveData(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const preserveData = { ...(value as Record<string, unknown>) };
  delete preserveData.openaiRemoteCompaction;
  return preserveData;
}

function nativeReplayData(value: unknown):
  | {
      provider?: string;
      replacementHistory: Array<Record<string, unknown>>;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const preserveData = value as Record<string, unknown>;
  const v2 = getCompactionV2PreserveData(preserveData);
  if (v2) return v2;
  return getPreservedOpenAiRemoteCompactionData(preserveData);
}

function preservedNativeReplayMechanism(
  preserveData: Record<string, unknown>,
): NativeReplayMechanism {
  const candidate = preserveData.openaiRemoteCompaction;
  return candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    "version" in candidate &&
    candidate.version === "v2"
    ? "v2"
    : "v1";
}

const REPLAY_DEADLINE_SKIPPED =
  "internal deadline reached; native replay skipped";

/** Structural slice of the compaction event the replay branch reads. */
interface NativeReplayEvent {
  signal?: AbortSignal;
  customInstructions?: unknown;
  branchEntries?: readonly unknown[];
  preparation: CompactionPreparation;
}

/**
 * Result of the provider-native replay branch. The branch is fail-isolated:
 * it reports its own status/error and never rejects the compaction.
 */
interface NativeReplayOutcome {
  status: NonNullable<LcmRuntimeStatus["lastNativeReplayStatus"]>;
  preserveData?: Record<string, unknown>;
  lineage?: NativeReplayLineageV1;
  provider?: string;
  itemCount?: number;
  seeded?: boolean;
  error?: string;
}

export function createController(ctx: any, injected: ControllerDeps = {}) {
  const deps = {
    ...injected,
    context: injected.context ?? ctx,
    status: injected.status ?? {},
  };
  const status: LcmRuntimeStatus = deps.status ?? {};
  const resolveTier = injected.resolveTier ?? resolveSummaryModel;

  /**
   * Run the provider-native replay branch. Started concurrently with the
   * textual LCM path (GAP-013): it reads only capture-independent inputs
   * (preparation, model, credentials, total deadline) and its result is
   * merged after a successful DAG build. It never rejects except on user
   * cancellation, which propagates to the fail-closed outer handler.
   */
  const runNativeReplay = async (
    mechanism: NativeReplayMechanism,
    total: Deadline,
    event: NativeReplayEvent,
  ): Promise<NativeReplayOutcome> => {
    try {
      const credential = await resolveNativeReplayCredential(ctx, total.signal);
      if (!credential) {
        return {
          status: "unavailable",
          error: "No API key for provider-native replay",
        };
      }
      const endpoint =
        mechanism === "v2" ? getCompactionV2Endpoint(ctx.model) : undefined;
      if (mechanism === "v2" && !endpoint)
        throw new Error("OMP V2 compaction endpoint is unavailable");
      const preferredLineage = createNativeReplayLineage(
        ctx.model,
        credential.identity,
        { mechanism, endpoint },
      );
      const v1FallbackLineage =
        mechanism === "v2"
          ? createNativeReplayLineage(ctx.model, credential.identity)
          : undefined;
      const savedLineage = parseNativeReplayLineage(
        event.preparation.previousPreserveData,
      );
      const previousReplay = nativeReplayData(
        event.preparation.previousPreserveData,
      );
      const compatible =
        previousReplay !== undefined &&
        (nativeReplayLineagesMatch(savedLineage, preferredLineage) ||
          (v1FallbackLineage !== undefined &&
            nativeReplayLineagesMatch(savedLineage, v1FallbackLineage)));
      const nativePreparation = {
        ...event.preparation,
        previousPreserveData: compatible
          ? event.preparation.previousPreserveData
          : withoutNativeReplayPreserveData(
              event.preparation.previousPreserveData,
            ),
      };
      const instructions =
        typeof event.customInstructions === "string" &&
        event.customInstructions.trim()
          ? event.customInstructions
          : SUMMARIZATION_SYSTEM_PROMPT;
      let nativeResult: { preserveData?: Record<string, unknown> };
      if (deps.requestNativeCompaction && mechanism === "v1") {
        const convertedMessages = defaultConvertToLlm([
          ...(nativePreparation.messagesToSummarize ?? []),
          ...(nativePreparation.turnPrefixMessages ?? []),
          ...(nativePreparation.recentMessages ?? []),
        ]);
        const nativeHistory = buildOpenAiNativeHistory(
          convertedMessages,
          ctx.model,
          compatible ? previousReplay?.replacementHistory : undefined,
        );
        const remote = await raceWithSignal(
          deps.requestNativeCompaction(
            ctx.model,
            credential.apiKey,
            nativeHistory,
            instructions,
            total.signal,
            { sessionId: ctx.sessionManager?.getSessionId?.() },
          ),
          total.signal,
        );
        nativeResult = {
          preserveData: withOpenAiRemoteCompactionPreserveData(
            nativePreparation.previousPreserveData,
            remote,
          ),
        };
      } else {
        const compact = deps.nativeCompact ?? runOmpCompaction;
        nativeResult = await raceWithSignal(
          compact(
            nativePreparation,
            ctx.model,
            credential.apiKey,
            instructions,
            total.signal,
            {
              remoteInstructions: instructions,
              thinkingLevel: activeThinkingLevel(event.branchEntries ?? []),
              sessionId: ctx.sessionManager?.getSessionId?.(),
            },
          ),
          total.signal,
        );
      }
      const replay = nativeReplayData(nativeResult.preserveData);
      if (!replay || replay.replacementHistory.length === 0)
        throw new Error(
          "OMP native compaction returned no replacement history",
        );
      const provider = replay.provider ?? ctx.model.provider;
      if (provider !== ctx.model.provider)
        throw new Error("Provider-native replay response provider mismatch");
      const preserved = nativeResult.preserveData;
      if (
        !preserved ||
        typeof preserved !== "object" ||
        !("openaiRemoteCompaction" in preserved)
      )
        throw new Error("OMP native compaction returned no preserve data");
      return {
        status: "preserved",
        preserveData: {
          openaiRemoteCompaction: preserved.openaiRemoteCompaction,
        },
        provider,
        itemCount: replay.replacementHistory.length,
        lineage:
          preservedNativeReplayMechanism(preserved) === "v2"
            ? preferredLineage
            : (v1FallbackLineage ?? preferredLineage),
        seeded: compatible,
      };
    } catch (error) {
      if (event.signal?.aborted) throw error;
      if (total?.expired() === true || isDeadlineAbort(error)) {
        status.lastDeadlineStage ??= "native-replay";
        notify(deps, `LCM native replay skipped: ${REPLAY_DEADLINE_SKIPPED}`);
        return { status: "failed", error: REPLAY_DEADLINE_SKIPPED };
      }
      const message = error instanceof Error ? error.message : String(error);
      notify(deps, `LCM native replay failed: ${message.slice(0, 300)}`);
      return { status: "failed", error: message.slice(0, 300) };
    }
  };

  const beforeCompact = async (event: any): Promise<any> => {
    let total: Deadline | undefined;
    try {
      status.lastOutcome = "running";
      status.lastStartedAt = new Date().toISOString();
      delete status.lastError;
      delete status.lastDeadlineStage;
      delete status.lastDeadlineFallbackCount;
      delete status.lastLeafModelError;
      delete status.lastRootModelError;
      delete status.lastTierRejections;
      const startedAt = Date.now();
      if (!event?.preparation)
        throw new Error("Missing compaction preparation");
      if (!ctx?.model) throw new Error("No active model");
      // The prelude bounds config loading only; the total deadline starts at
      // handler start so prelude time counts against the full budget.
      const prelude = Deadline.at(startedAt + 4_000, {
        signal: event.signal,
      });
      const config: LcmConfig = {
        ...(await raceWithSignal(
          readConfig(ctx, injected as any),
          prelude.signal,
        ).catch(() => configFromSettings(undefined))),
        ...injected.config,
      };
      total = Deadline.at(startedAt + config.handlerDeadlineMs, {
        signal: event.signal,
      });
      const totalSignal = total.signal;
      const settings = event.preparation.settings ?? {};
      if (
        !injected.summaryCall &&
        !injected.complete &&
        ctx.modelRegistry?.getApiKey
      ) {
        const key = await raceWithSignal(
          ctx.modelRegistry.getApiKey(ctx.model),
          total.signal,
        );
        if (!key) throw new Error("No API key for active model");
      }
      const renderer: Renderer =
        config.renderer === "context-full"
          ? "context-full"
          : config.renderer === "snapcompact"
            ? "snapcompact"
            : settings.strategy === "snapcompact" &&
                !event.customInstructions &&
                modelVision(ctx.model)
              ? "snapcompact"
              : "context-full";
      if (renderer === "snapcompact" && !modelVision(ctx.model))
        throw new NonVisionModelError();
      const manager = ctx.sessionManager;
      if (!manager?.saveArtifact)
        throw new Error("Session artifact API unavailable");
      const prior = parseLcmPreserveState(
        event.preparation.previousPreserveData?.ompLcmArtifactsV1,
      );
      delete status.lastOrphanArtifactCount;
      const orphanStore = orphanStoreFor(manager);
      if (orphanStore.listFiles) {
        try {
          status.lastOrphanArtifactCount = await countOrphanArtifacts(
            orphanStore,
            prior?.roots ?? [],
            { signal: total.signal, maxNodeReads: 1000 },
          );
        } catch {
          // best-effort observability; never fail the run over accounting
        }
      }
      const capture = await raceWithSignal(
        (deps.capture ?? captureRawSource)(event, undefined, {
          contextWindow: ctx.model?.contextWindow,
        }),
        total.signal,
      );
      status.lastRawChunkCount = capture.chunks.length;
      const leafStageMs = Math.floor((config.handlerDeadlineMs * 14) / 24);
      const replayRenderMs = Math.floor((config.handlerDeadlineMs * 4) / 24);
      const leafDeadline = new Deadline(leafStageMs, {
        signal: event.signal,
      });
      const rootDeadline = Deadline.at(total.deadlineAt - replayRenderMs, {
        signal: event.signal,
      });
      // Provider-native replay is independent of the textual LCM path: start
      // it now so its remote round-trip overlaps leaf summarization and DAG
      // construction (GAP-013). The textual LCM result stays authoritative;
      // replay failure is fail-isolated below and never invalidates a
      // completed textual compaction.
      let nativeReplayStatus: NonNullable<
        LcmRuntimeStatus["lastNativeReplayStatus"]
      > = "ineligible";
      let nativeReplayPreserveData: Record<string, unknown> | undefined;
      let nativeReplayLineage: NativeReplayLineageV1 | undefined;
      let nativeReplayProvider: string | undefined;
      let nativeReplayItemCount: number | undefined;
      let nativeReplaySeeded = false;
      let nativeReplayError: string | undefined;
      let nativeReplayOutcome: Promise<NativeReplayOutcome> | undefined;
      if (settings.remoteEnabled === false) {
        nativeReplayStatus = "disabled";
      } else {
        const mechanism = selectNativeReplayMechanism(ctx.model, settings);
        if (mechanism === undefined) {
          nativeReplayStatus = "ineligible";
        } else if (total.remainingMs() < replayRenderMs) {
          // Pathological case: capture itself consumed the deadline budget, so
          // a remote call would start already expired; skip it and keep the
          // render reserve intact.
          status.lastDeadlineStage ??= "native-replay";
          nativeReplayStatus = "failed";
          nativeReplayError = REPLAY_DEADLINE_SKIPPED;
          notify(deps, `LCM native replay skipped: ${REPLAY_DEADLINE_SKIPPED}`);
        } else {
          const promise = runNativeReplay(mechanism, total, event);
          // If the textual LCM path fails or the user cancels before this
          // promise is awaited, the no-op handler keeps any rejection from
          // surfacing as an unhandled rejection.
          void promise.catch(() => {});
          nativeReplayOutcome = promise;
        }
      }
      const makeModelCall =
        (
          model: unknown,
          apiKey: string | undefined,
          stage: "leaf" | "root",
        ): SummaryCall =>
        async (request: SummaryModelRequest) => {
          const sessionId = ctx.sessionManager?.getSessionId?.();
          const registryResolver = registryApiKeyResolver(
            ctx.modelRegistry,
            model,
            sessionId,
          );
          // A tier snapshot seeds the first attempt; any auth failure falls
          // back to the registry's refresh/rotation policy instead of failing
          // the call (GAP-006 closure).
          const keySource: ApiKey | undefined =
            apiKey === undefined || apiKey === ""
              ? (registryResolver ?? undefined)
              : registryResolver
                ? seedApiKeyResolver(apiKey, registryResolver)
                : apiKey;
          const completionContext = {
            systemPrompt: [request.prompt],
            messages: [
              {
                role: "user" as const,
                content: request.input,
                timestamp: Date.now(),
              },
            ],
          };
          const attempt = (key: string) =>
            deps.complete !== undefined
              ? deps.complete(model, completionContext, {
                  apiKey: key,
                  maxTokens: request.targetTokens,
                  signal: request.signal,
                })
              : // OMP Model objects are structurally compatible with pi-ai's
                // Model type; the registry hands us the session's model.
                completeModel(
                  model as Parameters<typeof completeModel>[0],
                  completionContext,
                  {
                    apiKey: key,
                    maxTokens: request.targetTokens,
                    signal: request.signal,
                  },
                );
          try {
            const response = await withAuth(keySource, attempt, {
              signal: request.signal,
            });
            return completionText(response);
          } catch (error) {
            recordModelCallError(status, stage, error);
            throw error;
          }
        };
      const call: SummaryCall =
        deps.summaryCall ?? makeModelCall(ctx.model, undefined, "leaf");
      let deterministicFallbackCount = 0;
      let deadlineFallbackCount = 0;
      let completedModelSummaryCount = 0;
      const summarize = deps.summarize ?? summarizeText;
      const runSummary = async (
        request: SummaryRequest,
        modelCall: SummaryCall,
      ): Promise<SummaryResult> => {
        const summary = await summarize(request, modelCall);
        if (summary.level === "deterministic") deterministicFallbackCount++;
        return summary;
      };
      const tiersActive = !injected.summaryCall;
      const tierDeps: TierResolverDeps = {
        models: ctx.models,
        modelRegistry: ctx.modelRegistry,
        sessionId: ctx.sessionManager?.getSessionId?.(),
      };
      const tierRejections: string[] = [];
      const observeTier =
        (stage: "leaf" | "root") => (observation: TierCandidateObservation) => {
          if (!observation.ok)
            tierRejections.push(
              `${stage}:${observation.role}:${observation.label}:${observation.reason}`,
            );
        };
      let leafModel: ResolvedSummaryModel | undefined;
      if (tiersActive) {
        try {
          leafModel = await resolveTier(
            preferredChain(config.leafSummaryModel, TIER_CHAINS.leaf),
            tierDeps,
            {
              signal: total.signal,
              activeModel: ctx.model,
              minContextWindow:
                SUMMARY_RESERVE_TOKENS + MIN_VIABLE_BATCH_TOKENS,
              onCandidate: observeTier("leaf"),
            },
          );
        } catch (error) {
          // Internal deadline expiry degrades to the active-model path
          // (its calls are deadline-bounded and fall back deterministically);
          // real failures and user cancellation still propagate.
          if (event.signal?.aborted) throw error;
          if (!isDeadlineAbort(error) && total?.expired() !== true) throw error;
        }
        status.lastLeafSummaryModel = leafModel?.label;
      }
      status.lastSummaryConcurrency = config.summaryConcurrency;
      const leafBudget = batchBudgetFor(
        config.summaryBatchInputTokens,
        leafModel?.model.contextWindow,
      );
      const batches = planSummaryBatches(capture.chunks, {
        maxInputTokens: leafBudget,
        signal: event.signal,
      });
      status.lastSummaryBatchCount = batches.length;
      const leafCall: SummaryCall =
        leafModel === undefined
          ? call
          : makeModelCall(leafModel.model.model, leafModel.apiKey, "leaf");
      const leafWorker = async (
        batch: SummaryBatch,
      ): Promise<SummaryResult> => {
        if (batch.oversized) {
          deterministicFallbackCount++;
          return deterministicSummary(batch.input, 2048);
        }
        const perCall = new Deadline(
          Math.min(9_000, leafDeadline.remainingMs()),
          { signal: leafDeadline.signal },
        );
        try {
          return await runSummary(
            {
              input: batch.input,
              targetTokens: 2048,
              signal: perCall.signal,
            },
            leafCall,
          );
        } catch (error) {
          if (event.signal?.aborted) throw error;
          if (perCall.expired() || leafDeadline.expired()) {
            deadlineFallbackCount++;
            status.lastDeadlineStage ??= "leaf";
            return deterministicSummary(batch.input, 2048);
          }
          throw error;
        }
      };
      const outcomes = await runBoundedPool(
        batches,
        config.summaryConcurrency,
        leafWorker,
        { signal: leafDeadline.signal },
      );
      const leaves: Array<{
        summary: string;
        rawContents: string[];
        sourceEntryIds: string[];
        tokenCount: number;
      }> = [];
      for (let index = 0; index < batches.length; index++) {
        const batch = batches[index];
        const outcome = outcomes[index];
        let result: SummaryResult;
        if (outcome.status === "ok") {
          result = outcome.value;
        } else {
          result = deterministicSummary(batch.input, 2048);
          if (outcome.status === "skipped") deadlineFallbackCount++;
          else deterministicFallbackCount++;
        }
        if (result.level !== "deterministic") completedModelSummaryCount++;
        leaves.push({
          summary: result.prose,
          rawContents: batch.chunkIndexes.map(
            (index) => capture.chunks[index]?.content ?? "",
          ),
          sourceEntryIds: batch.sourceEntryIds,
          tokenCount: result.tokenCount,
        });
      }
      const generation = (prior?.generation ?? 0) + 1;
      let rootModel: ResolvedSummaryModel | undefined;
      if (tiersActive) {
        try {
          rootModel = await resolveTier(
            preferredChain(config.rootSummaryModel, TIER_CHAINS.root),
            tierDeps,
            {
              signal: total.signal,
              activeModel: ctx.model,
              minContextWindow:
                SUMMARY_RESERVE_TOKENS + MIN_VIABLE_BATCH_TOKENS,
              onCandidate: observeTier("root"),
            },
          );
        } catch (error) {
          // Same graceful degrade as the leaf tier: deadline expiry falls
          // back to the active model (deadline-bounded, deterministic
          // fallback); real failures and user cancellation propagate.
          if (event.signal?.aborted) throw error;
          if (!isDeadlineAbort(error) && total?.expired() !== true) throw error;
        }
        status.lastRootSummaryModel = rootModel?.label;
      }
      status.lastTierRejections = tierRejections.slice(0, 8);
      const rootCall: SummaryCall =
        rootModel === undefined
          ? deps.summaryCall !== undefined
            ? leafCall // injected seam serves both stages
            : makeModelCall(ctx.model, undefined, "root")
          : makeModelCall(rootModel.model.model, rootModel.apiKey, "root");
      const runRootSummary = async (
        request: SummaryRequest,
      ): Promise<SummaryResult> => {
        try {
          return await runSummary(request, rootCall);
        } catch (error) {
          if (event.signal?.aborted) throw error;
          if (rootDeadline.expired()) {
            deadlineFallbackCount++;
            status.lastDeadlineStage ??= "root";
            return deterministicSummary(request.input, request.targetTokens);
          }
          throw error;
        }
      };
      const dag = await (deps.dag ?? buildDag)({
        store: manager,
        generation,
        priorRoots: prior?.roots as any,
        leaves,
        previousSummary: prior ? undefined : event.preparation.previousSummary,
        repairRoot: async (root, targetTokens) => {
          if (
            !/Archived source \(deterministic fallback\):|Archived LCM history:|(?:Root 1:\s*){2,}/u.test(
              root.summary,
            )
          )
            return undefined;
          const repaired = await runRootSummary({
            input: root.summary,
            targetTokens,
            category: "degraded LCM root repair",
            signal: totalSignal,
          });
          return repaired.level === "deterministic"
            ? undefined
            : repaired.prose;
        },
        summarize: async (input, targetTokens) =>
          (
            await runRootSummary({
              input,
              targetTokens,
              category: "LCM root condensation",
              signal: totalSignal,
            })
          ).prose,
        // Write-loop abort checks observe user cancellation only: the raw/node
        // writes are fast file ops that must complete even when the internal
        // deadline expires mid-loop, so the run degrades (deterministic
        // fallbacks) instead of cancelling. Model calls inside the loop are
        // bounded separately via the request signals above.
        signal: event.signal,
      });
      if (nativeReplayOutcome !== undefined) {
        const outcome = await nativeReplayOutcome;
        nativeReplayStatus = outcome.status;
        nativeReplayPreserveData = outcome.preserveData;
        nativeReplayLineage = outcome.lineage;
        nativeReplayProvider = outcome.provider;
        nativeReplayItemCount = outcome.itemCount;
        nativeReplaySeeded = outcome.seeded ?? false;
        nativeReplayError = outcome.error;
      }
      status.lastSnapcompactFrameCount = undefined;
      const degradeToContextFull =
        renderer === "snapcompact" &&
        total.remainingMs() < Math.min(2_500, replayRenderMs);
      if (degradeToContextFull) status.lastDeadlineStage ??= "total";
      let result =
        renderer === "context-full" || degradeToContextFull
          ? renderContextFull({
              preparation: event.preparation,
              state: dag.state,
            })
          : await renderSnapcompact({
              preparation: event.preparation,
              state: dag.state,
              model: ctx.model,
              signal: total.signal,
              onResult: (snapResult) => {
                status.lastSnapcompactFrameCount = frameCount(snapResult);
              },
            });
      if (nativeReplayPreserveData && nativeReplayLineage) {
        result = {
          ...result,
          preserveData: {
            ...result.preserveData,
            ...nativeReplayPreserveData,
            [NATIVE_REPLAY_LINEAGE_KEY]: nativeReplayLineage,
          },
        };
      }
      status.lastRenderer = renderer;
      status.lastGeneration = generation;
      status.lastRootCount = dag.state.roots.length;
      status.lastRoots = dag.state.roots.map((root) => ({
        artifactId: root.artifactId,
        level: root.level,
        sourceEntryCount: root.sourceEntryCount,
        tokenCount: root.tokenCount,
      }));
      status.lastRawArtifactCount = capture.chunks.length;
      status.lastSourceEntryCount = leaves.reduce(
        (count, leaf) => count + leaf.sourceEntryIds.length,
        0,
      );
      status.lastTokensBefore =
        typeof result.tokensBefore === "number"
          ? result.tokensBefore
          : undefined;
      status.lastFirstKeptEntryId =
        typeof result.firstKeptEntryId === "string"
          ? result.firstKeptEntryId
          : undefined;
      status.lastSummaryPreview = boundedPreview(result.summary);
      status.lastPreserveKeys =
        result.preserveData && typeof result.preserveData === "object"
          ? Object.keys(result.preserveData)
          : [];
      status.builtInRemoteContextFullIntercepted =
        settings.remoteEnabled !== false && renderer === "context-full";
      status.lastDeterministicFallbackCount = deterministicFallbackCount;
      status.lastSummaryQuality =
        deterministicFallbackCount === 0 && deadlineFallbackCount === 0
          ? "model"
          : "deterministic-fallback";
      status.lastCompletedModelSummaryCount = completedModelSummaryCount;
      status.lastDeadlineFallbackCount = deadlineFallbackCount;
      status.lastElapsedMs = Date.now() - startedAt;
      status.lastNativeReplayStatus = nativeReplayStatus;
      status.lastNativeReplayProvider = nativeReplayProvider;
      status.lastNativeReplayItemCount = nativeReplayItemCount;
      status.lastNativeReplaySeeded = nativeReplaySeeded;
      if (nativeReplayError)
        status.lastNativeReplayError = nativeReplayError.slice(0, 300);
      else delete status.lastNativeReplayError;
      status.lastOutcome = "success";
      delete status.lastError;
      persistRuntimeStatus(ctx, status);
      return { compaction: result };
    } catch (error: any) {
      if (event?.signal?.aborted) {
        status.lastOutcome = "cancelled";
        return { cancel: true };
      }
      if (isDeadlineAbort(error) || total?.expired() === true) {
        status.lastOutcome = "error";
        status.lastError = "internal deadline reached";
        status.lastDeadlineStage ??= "total";
        persistRuntimeStatus(ctx, status);
        return { cancel: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      status.lastOutcome = "cancelled";
      status.lastError = message.slice(0, 300);
      notify(deps, message);
      persistRuntimeStatus(ctx, status);
      return { cancel: true };
    }
  };
  return { beforeCompact, status };
}

export function registerController(
  api: any,
  ctx: any,
  injected: ControllerDeps = {},
) {
  const controller = createController(ctx, injected);
  api.on?.("session_before_compact", controller.beforeCompact);
  return controller;
}
