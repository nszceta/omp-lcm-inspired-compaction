import { persistRenderer, type Renderer, readConfig } from "./config.ts";
import { type LcmPreserveStateV1, parseLcmPreserveState } from "./contracts.ts";
import { buildDag } from "./dag.ts";
import { renderContextFull } from "./render-context-full.ts";
import {
  NonVisionModelError,
  renderSnapcompact,
} from "./render-snapcompact.ts";
import { captureRawSource } from "./source.ts";
import { summarizeText } from "./summarize.ts";

export interface LcmRuntimeStatus {
  lastRenderer?: "context-full" | "snapcompact";
  lastGeneration?: number;
  lastRootCount?: number;
  lastRemoteEnabledIntercepted?: boolean;
  lastOutcome?: "success" | "cancelled";
  lastError?: string;
}
export interface LcmController {
  beforeCompact: (event: any) => Promise<any>;
  status: LcmRuntimeStatus;
}

export interface ControllerDeps {
  capture?: typeof captureRawSource;
  summarize?: typeof summarizeText;
  dag?: typeof buildDag;
  context?: any;
  summaryCall?: (request: any) => Promise<string>;
  notify?: (message: string) => void;
  log?: (message: string) => void;
  status?: LcmRuntimeStatus;
}

function notify(deps: ControllerDeps, text: string) {
  deps.notify?.(text);
  deps.log?.(text);
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
      if (!injected.summaryCall && ctx.modelRegistry?.getApiKey) {
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
      const call =
        deps.summaryCall ??
        (async (request: any) => {
          const mod: any = await import("@oh-my-pi/pi-ai");
          const key = await ctx.modelRegistry?.getApiKey?.(ctx.model);
          const response = await mod.complete(
            ctx.model,
            { prompt: request.prompt, input: request.input },
            {
              apiKey: key,
              maxTokens: request.targetTokens,
              signal: request.signal,
            },
          );
          return typeof response === "string"
            ? response
            : String(response?.text ?? response?.content ?? "");
        });
      const chunks = capture.chunks;
      const leaves = [];
      for (const chunk of chunks) {
        const result = await (deps.summarize ?? summarizeText)(
          { input: chunk.content, targetTokens: 2048, signal: event.signal },
          call,
        );
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
        signal: event.signal,
      });
      const result =
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
            });
      status.lastRenderer = renderer;
      status.lastGeneration = generation;
      status.lastRootCount = dag.state.roots.length;
      status.lastRemoteEnabledIntercepted =
        settings.remoteEnabled !== false && renderer === "context-full";
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
