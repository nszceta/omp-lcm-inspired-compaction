import type { OpenAiRemoteCompactionResponse } from "@oh-my-pi/pi-agent-core/compaction";
import {
  buildOpenAiNativeHistory,
  defaultConvertToLlm,
  getPreservedOpenAiRemoteCompactionData,
  requestOpenAiRemoteCompaction,
  SUMMARIZATION_SYSTEM_PROMPT,
  shouldUseOpenAiRemoteCompaction,
  withOpenAiRemoteCompactionPreserveData,
} from "@oh-my-pi/pi-agent-core/compaction";
import { complete as completeModel } from "@oh-my-pi/pi-ai";
import { type Renderer, readConfig } from "./config.ts";
import { parseLcmPreserveState } from "./contracts.ts";
import { buildDag } from "./dag.ts";
import { renderContextFull } from "./render-context-full.ts";
import {
  NonVisionModelError,
  renderSnapcompact,
} from "./render-snapcompact.ts";
import { captureRawSource, serializeSummaryEntries } from "./source.ts";
import type {
  SummaryCall,
  SummaryModelRequest,
  SummaryRequest,
  SummaryResult,
} from "./summarize.ts";
import { summarizeText } from "./summarize.ts";

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
  lastSourceEntryCount?: number;
  lastTokensBefore?: number;
  lastFirstKeptEntryId?: string;
  lastSummaryPreview?: string;
  lastPreserveKeys?: string[];
  lastSnapcompactFrameCount?: number;
  builtInRemoteContextFullIntercepted?: boolean;
  lastOutcome?: "success" | "cancelled";
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
    apiKey: string | undefined;
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
  requestNativeCompaction?: typeof requestOpenAiRemoteCompaction;
  notify?: (message: string) => void;
  log?: (message: string) => void;
  status?: LcmRuntimeStatus;
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

export function createController(ctx: any, injected: ControllerDeps = {}) {
  const deps = {
    ...injected,
    context: injected.context ?? ctx,
    status: injected.status ?? {},
  };
  const status: LcmRuntimeStatus = deps.status ?? {};
  const beforeCompact = async (event: any): Promise<any> => {
    try {
      if (!event?.preparation)
        throw new Error("Missing compaction preparation");
      if (!ctx?.model) throw new Error("No active model");
      const config = await readConfig(ctx, injected as any);
      const settings = event.preparation.settings ?? {};
      if (
        !injected.summaryCall &&
        !injected.complete &&
        ctx.modelRegistry?.getApiKey
      ) {
        const key = await ctx.modelRegistry.getApiKey(ctx.model);
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
      const capture = await (deps.capture ?? captureRawSource)(
        event,
        (content, toolType) => manager.saveArtifact(content, toolType),
        { contextWindow: ctx.model?.contextWindow },
      );
      const prior = parseLcmPreserveState(
        event.preparation.previousPreserveData?.ompLcmArtifactsV1,
      );
      const call: SummaryCall =
        deps.summaryCall ??
        (async (request: SummaryModelRequest) => {
          const key = await ctx.modelRegistry?.getApiKey?.(ctx.model);
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
          const completionOptions = {
            apiKey: key,
            maxTokens: request.targetTokens,
            signal: request.signal,
          };
          const response = deps.complete
            ? await deps.complete(
                ctx.model,
                completionContext,
                completionOptions,
              )
            : await completeModel(
                ctx.model,
                completionContext,
                completionOptions,
              );
          return completionText(response);
        });
      let deterministicFallbackCount = 0;
      const summarize = deps.summarize ?? summarizeText;
      const runSummary = async (
        request: SummaryRequest,
      ): Promise<SummaryResult> => {
        const summary = await summarize(request, call);
        if (summary.level === "deterministic") deterministicFallbackCount++;
        return summary;
      };
      const chunks = capture.chunks;
      const leaves = [];
      for (const chunk of chunks) {
        const result = await runSummary({
          input: serializeSummaryEntries(chunk.entries),
          targetTokens: 2048,
          signal: event.signal,
        });
        leaves.push({
          summary: result.prose,
          rawArtifactIds: capture.rawArtifactIds.slice(
            leaves.length,
            leaves.length + 1,
          ),
          sourceEntryIds: chunk.entries.map((x: any) =>
            String(x.id ?? x.entryId ?? ""),
          ),
          tokenCount: result.tokenCount,
        });
      }
      const generation = (prior?.generation ?? 0) + 1;
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
          const repaired = await runSummary({
            input: root.summary,
            targetTokens,
            category: "degraded LCM root repair",
            signal: event.signal,
          });
          return repaired.level === "deterministic"
            ? undefined
            : repaired.prose;
        },
        summarize: async (input, targetTokens) =>
          (
            await runSummary({
              input,
              targetTokens,
              category: "LCM root condensation",
              signal: event.signal,
            })
          ).prose,
        signal: event.signal,
      });
      let nativeReplayStatus: NonNullable<
        LcmRuntimeStatus["lastNativeReplayStatus"]
      > = "ineligible";
      let nativeReplay: OpenAiRemoteCompactionResponse | undefined;
      let nativeReplaySeeded = false;
      let nativeReplayError: string | undefined;
      if (settings.remoteEnabled === false) {
        nativeReplayStatus = "disabled";
      } else if (shouldUseOpenAiRemoteCompaction(ctx.model)) {
        try {
          const remoteMessages = [
            ...(event.preparation.messagesToSummarize ?? []),
            ...(event.preparation.turnPrefixMessages ?? []),
            ...(event.preparation.recentMessages ?? []),
          ];
          const previousReplay = getPreservedOpenAiRemoteCompactionData(
            event.preparation.previousPreserveData,
          );
          const previousReplacementHistory =
            previousReplay && previousReplay.provider === ctx.model.provider
              ? previousReplay.replacementHistory
              : undefined;
          nativeReplaySeeded = previousReplacementHistory !== undefined;
          const nativeHistory = buildOpenAiNativeHistory(
            defaultConvertToLlm(remoteMessages),
            ctx.model,
            previousReplacementHistory,
          );
          if (nativeHistory.length === 0) {
            nativeReplayStatus = "empty";
          } else {
            const apiKey = await ctx.modelRegistry?.getApiKey?.(ctx.model);
            if (!apiKey) {
              nativeReplayStatus = "unavailable";
              nativeReplayError = "No API key for provider-native replay";
            } else {
              const request =
                deps.requestNativeCompaction ?? requestOpenAiRemoteCompaction;
              const remote = await request(
                ctx.model,
                apiKey,
                nativeHistory,
                typeof event.customInstructions === "string" &&
                  event.customInstructions.trim()
                  ? event.customInstructions
                  : SUMMARIZATION_SYSTEM_PROMPT,
                event.signal,
              );
              const provider = remote.provider ?? ctx.model.provider;
              if (
                typeof provider !== "string" ||
                provider.length === 0 ||
                provider !== ctx.model.provider
              )
                throw new Error(
                  "Provider-native replay response provider mismatch",
                );
              if (
                !Array.isArray(remote.replacementHistory) ||
                remote.replacementHistory.length === 0
              )
                throw new Error(
                  "Provider-native replay returned empty replacement history",
                );
              nativeReplay = { ...remote, provider };
              nativeReplayStatus = "preserved";
            }
          }
        } catch (error) {
          if (event.signal?.aborted) throw error;
          nativeReplayStatus = "failed";
          nativeReplayError =
            error instanceof Error ? error.message : String(error);
        }
      }
      status.lastSnapcompactFrameCount = undefined;
      let result =
        renderer === "context-full"
          ? renderContextFull({
              preparation: event.preparation,
              state: dag.state,
            })
          : await renderSnapcompact({
              preparation: event.preparation,
              state: dag.state,
              model: ctx.model,
              signal: event.signal,
              onResult: (snapResult) => {
                status.lastSnapcompactFrameCount = frameCount(snapResult);
              },
            });
      if (nativeReplay) {
        result = {
          ...result,
          preserveData: withOpenAiRemoteCompactionPreserveData(
            result.preserveData,
            nativeReplay,
          ),
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
      status.lastRawArtifactCount = capture.rawArtifactIds.length;
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
        deterministicFallbackCount === 0 ? "model" : "deterministic-fallback";
      status.lastNativeReplayStatus = nativeReplayStatus;
      status.lastNativeReplayProvider = nativeReplay?.provider;
      status.lastNativeReplayItemCount =
        nativeReplay?.replacementHistory.length;
      status.lastNativeReplaySeeded = nativeReplaySeeded;
      if (nativeReplayError)
        status.lastNativeReplayError = nativeReplayError.slice(0, 300);
      else delete status.lastNativeReplayError;
      status.lastOutcome = "success";
      delete status.lastError;
      return { compaction: result };
    } catch (error: any) {
      if (event?.signal?.aborted) {
        status.lastOutcome = "cancelled";
        return { cancel: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      status.lastOutcome = "cancelled";
      status.lastError = message.slice(0, 300);
      notify(deps, message);
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
