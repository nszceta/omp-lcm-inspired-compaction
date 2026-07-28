import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
  ExtensionActions,
  ExtensionContextActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { LcmRuntimeStatus } from "../src/controller.ts";
import { createLcmExtension } from "../src/index.ts";

const SPARK = "openai-codex/gpt-5.3-codex-spark";
const LUNA = "openai-codex/gpt-5.6-luna";
const LIVE = Bun.env.LCM_LIVE_INTEGRATION === "1";
const liveTest = LIVE ? test : test.skip;

function containsEncryptedPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsEncryptedPayload);
  if (!value || typeof value !== "object") return false;
  const payload = value as {
    encrypted_content?: unknown;
    encryptedContent?: unknown;
    [key: string]: unknown;
  };
  if (
    (typeof payload.encrypted_content === "string" &&
      payload.encrypted_content.length > 0) ||
    (typeof payload.encryptedContent === "string" &&
      payload.encryptedContent.length > 0)
  )
    return true;
  return Object.values(payload).some(containsEncryptedPayload);
}

function latestCompactionPreserveData(
  entries: readonly unknown[],
): Record<string, unknown> {
  for (let index = entries.length - 1; index >= 0; index--) {
    const value = entries[index];
    if (!value || typeof value !== "object") continue;
    const entry = value as { type?: unknown; preserveData?: unknown };
    if (
      entry.type === "compaction" &&
      entry.preserveData &&
      typeof entry.preserveData === "object" &&
      !Array.isArray(entry.preserveData)
    )
      return entry.preserveData as Record<string, unknown>;
  }
  const entryTypes = entries.map((value) => {
    if (value && typeof value === "object" && "type" in value)
      return String(value.type);
    return typeof value;
  });
  throw new Error(
    `Session did not persist a compaction entry; entries=${entryTypes.join(",")}`,
  );
}

function replayHistory(preserveData: Record<string, unknown>): unknown[] {
  const value = preserveData.openaiRemoteCompaction;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Compaction did not persist replacement history");
  const replay = value as { replacementHistory?: unknown };
  if (!Array.isArray(replay.replacementHistory))
    throw new Error("Compaction did not persist replacement history");
  return replay.replacementHistory;
}

function lcmGeneration(preserveData: Record<string, unknown>): number {
  const value = preserveData.ompLcmArtifactsV1;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Compaction did not persist LCM state");
  const state = value as { generation?: unknown; roots?: unknown };
  if (typeof state.generation !== "number")
    throw new Error("Compaction did not persist LCM state");
  if (!Array.isArray(state.roots) || state.roots.length === 0)
    throw new Error("Compaction persisted no LCM roots");
  return state.generation;
}

function lineageModel(preserveData: Record<string, unknown>): string {
  const value = preserveData.ompLcmNativeReplayLineageV1;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Compaction did not persist native replay lineage");
  const lineage = value as { modelId?: unknown };
  if (typeof lineage.modelId !== "string")
    throw new Error("Compaction did not persist native replay lineage");
  return lineage.modelId;
}

function lineageApiVariant(preserveData: Record<string, unknown>): string {
  const value = preserveData.ompLcmNativeReplayLineageV1;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Compaction did not persist native replay lineage");
  const lineage = value as { apiVariant?: unknown };
  if (typeof lineage.apiVariant !== "string")
    throw new Error("Compaction did not persist native replay API variant");
  return lineage.apiVariant;
}

function initializeExtensionContext(session: AgentSession): void {
  const runner = session.extensionRunner;
  if (!runner) throw new Error("LCM extension runner is unavailable");
  const actions: ExtensionActions = {
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: (customType, data) => {
      session.sessionManager.appendCustomEntry(customType, data);
    },
    setLabel: (targetId, label) => {
      session.sessionManager.appendLabelChange(targetId, label);
    },
    getActiveTools: () => session.getEnabledToolNames(),
    getAllTools: () => session.getAllToolNames(),
    setActiveTools: async (toolNames) => {
      await session.setActiveToolsByName(toolNames);
    },
    getCommands: () => [],
    setModel: async (model) => {
      await session.setModelTemporary(model, session.thinkingLevel);
      return true;
    },
    getThinkingLevel: () => session.thinkingLevel,
    setThinkingLevel: (level) => {
      session.setThinkingLevel(level);
    },
    getSessionName: () => session.sessionManager.getSessionName(),
    setSessionName: async () => {},
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => session.model,
    isIdle: () => !session.isStreaming,
    abort: () => {
      session.abort({ reason: "integration-test" });
    },
    hasPendingMessages: () => session.queuedMessageCount > 0,
    shutdown: () => {},
    getContextUsage: () => session.getContextUsage(),
    compact: async () => {},
    getSystemPrompt: () => session.systemPrompt,
  };
  runner.initialize(actions, contextActions);
}

async function createLiveLcmSession(modelPattern: string) {
  const status: LcmRuntimeStatus = {};
  const settings = Settings.isolated({
    "compaction.keepRecentTokens": 1,
    "compaction.remoteEnabled": true,
    "compaction.autoContinue": false,
  });
  const sessionManager = SessionManager.inMemory(process.cwd());
  await sessionManager.saveArtifact("integration seed", "lcm-test-seed");
  const result = await createAgentSession({
    cwd: process.cwd(),
    modelPattern,
    thinkingLevel: ThinkingLevel.Low,
    sessionManager,
    settings,
    extensions: [
      (api) => {
        createLcmExtension({
          deps: {
            status,
            getPluginSettings: () => ({ renderer: "context-full" }),
          },
        })(api);
      },
    ],
    disableExtensionDiscovery: true,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    toolNames: [],
    autoApprove: true,
    systemPrompt:
      "Answer each user message in one short sentence. Do not call tools.",
  });
  initializeExtensionContext(result.session);
  return { session: result.session, status };
}

async function addTurnAndCompact(
  session: AgentSession,
  status: LcmRuntimeStatus,
  marker: string,
  requireNativeReplay = true,
): Promise<Record<string, unknown>> {
  const preludeCompleted = await session.prompt(
    `Reply with the marker ${marker}_PRELUDE and no other details.`,
  );
  if (!preludeCompleted)
    throw new Error(`Provider did not complete prelude for ${marker}`);
  const completed = await session.prompt(
    `Reply with the marker ${marker} and no other details.`,
  );
  if (!completed) throw new Error(`Provider did not complete turn ${marker}`);
  try {
    await session.compact(`Retain the marker ${marker}.`);
  } catch (error) {
    throw new Error(
      `LCM compaction threw for ${marker}: ${JSON.stringify(status)}`,
      { cause: error },
    );
  }
  if (status.lastOutcome !== "success")
    throw new Error(
      `LCM compaction failed for ${marker}: ${JSON.stringify(status)}`,
    );
  if (requireNativeReplay && status.lastNativeReplayStatus !== "preserved")
    throw new Error(
      `Native replay failed for ${marker}: ${JSON.stringify(status)}`,
    );
  return latestCompactionPreserveData(session.sessionManager.getEntries());
}

describe("live provider-native replay integration", () => {
  liveTest(
    "starts a fresh Luna replay after switching from Spark",
    async () => {
      const { session, status } = await createLiveLcmSession(SPARK);
      try {
        const sparkPreserve = await addTurnAndCompact(
          session,
          status,
          "SPARK_LINEAGE_ROUND",
        );
        expect(lineageModel(sparkPreserve)).toBe("gpt-5.3-codex-spark");
        expect(lineageApiVariant(sparkPreserve)).toBe(
          "openai-codex-responses:standard:streaming-v2",
        );
        expect(containsEncryptedPayload(replayHistory(sparkPreserve))).toBe(
          true,
        );
        expect(status.lastNativeReplaySeeded).toBe(false);

        const luna = session.modelRegistry.find("openai-codex", "gpt-5.6-luna");
        if (!luna) throw new Error(`Model ${LUNA} is unavailable`);
        await session.setModelTemporary(luna, ThinkingLevel.Low);
        const lunaPreserve = await addTurnAndCompact(
          session,
          status,
          "LUNA_NEW_LINEAGE_ROUND",
        );

        expect(status.lastNativeReplaySeeded).toBe(false);
        expect(lcmGeneration(lunaPreserve)).toBe(2);
        expect(lineageModel(lunaPreserve)).toBe("gpt-5.6-luna");
        expect(lineageApiVariant(lunaPreserve)).toBe(
          "openai-codex-responses:responses-lite:streaming-v2",
        );
        expect(containsEncryptedPayload(replayHistory(lunaPreserve))).toBe(
          true,
        );
      } finally {
        await session.dispose();
      }
    },
    300_000,
  );

  liveTest(
    "retains LCM and encrypted Spark replay across two compactions",
    async () => {
      const { session, status } = await createLiveLcmSession(SPARK);
      try {
        const first = await addTurnAndCompact(
          session,
          status,
          "SPARK_ROUND_ONE",
        );
        const firstHistory = replayHistory(first);
        expect(lcmGeneration(first)).toBe(1);
        expect(lineageModel(first)).toBe("gpt-5.3-codex-spark");
        expect(lineageApiVariant(first)).toBe(
          "openai-codex-responses:standard:streaming-v2",
        );
        expect(containsEncryptedPayload(firstHistory)).toBe(true);
        expect(status.lastNativeReplaySeeded).toBe(false);

        const second = await addTurnAndCompact(
          session,
          status,
          "SPARK_ROUND_TWO",
        );
        const secondHistory = replayHistory(second);
        expect(lcmGeneration(second)).toBe(2);
        expect(lineageModel(second)).toBe("gpt-5.3-codex-spark");
        expect(lineageApiVariant(second)).toBe(
          "openai-codex-responses:standard:streaming-v2",
        );
        expect(containsEncryptedPayload(secondHistory)).toBe(true);
        expect(secondHistory).not.toEqual(firstHistory);
        expect(status.lastNativeReplayStatus).toBe("preserved");
        expect(status.lastNativeReplaySeeded).toBe(true);
      } finally {
        await session.dispose();
      }
    },
    300_000,
  );
});
