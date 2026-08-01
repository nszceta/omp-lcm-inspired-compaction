import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
  ExtensionActions,
  ExtensionContextActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
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

const REPLACEMENT_HISTORY = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "provider-preserved turn" }],
  },
  {
    type: "compaction",
    encrypted_content: "gap-004-encrypted-compaction",
  },
] satisfies Array<Record<string, unknown>>;

async function rebuildPersistedProviderContext() {
  const storage = new MemorySessionStorage();
  const sessionFile = `/sessions/gap-004-${crypto.randomUUID()}.jsonl`;
  storage.writeTextSync(sessionFile, "");
  const manager = await SessionManager.open(sessionFile, "/sessions", storage, {
    initialCwd: process.cwd(),
    suppressBreadcrumb: true,
  });
  const firstKeptEntryId = manager.appendMessage({
    role: "user",
    content: "This local turn is replaced by provider-native history.",
    timestamp: Date.now(),
  });
  manager.appendCompaction(
    "LCM textual summary",
    "LCM summary",
    firstKeptEntryId,
    1_000,
    undefined,
    true,
    {
      openaiRemoteCompaction: {
        provider: "openai",
        replacementHistory: REPLACEMENT_HISTORY,
      },
    },
  );
  manager.appendMessage({
    role: "user",
    content: "next request after persisted compaction",
    timestamp: Date.now() + 1,
  });
  await manager.close();

  const resumed = await SessionManager.open(sessionFile, "/sessions", storage, {
    initialCwd: process.cwd(),
    suppressBreadcrumb: true,
  });
  return {
    resumed,
    context: resumed.buildSessionContext(),
  };
}

function successfulResponsesStream(): Response {
  const messageId = "msg_gap_004";
  const responseId = "resp_gap_004";
  const events = [
    {
      type: "response.created",
      response: { id: responseId, status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: "ok",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OMP provider-native context reconstruction", () => {
  test("reattaches persisted replacement history to the active summary", async () => {
    const { resumed, context } = await rebuildPersistedProviderContext();
    try {
      expect(context.messages).toHaveLength(2);
      expect(context.messages[0]).toMatchObject({
        role: "compactionSummary",
        providerPayload: {
          type: "openaiResponsesHistory",
          provider: "openai",
          items: REPLACEMENT_HISTORY,
        },
      });
      expect(context.messages[1]).toMatchObject({
        role: "user",
        content: "next request after persisted compaction",
      });
    } finally {
      await resumed.close();
    }
  });

  test("transmits rebuilt replacement history in the next Responses request", async () => {
    const { resumed, context } = await rebuildPersistedProviderContext();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    try {
      const model = getBundledModel<"openai-responses">("openai", "gpt-5.4");
      const stream = streamOpenAIResponses(
        model,
        {
          systemPrompt: [],
          messages: convertToLlm(context.messages),
          tools: [],
        },
        {
          apiKey: "integration-test-key",
          fetch: async (input, init) => {
            if (typeof init?.body !== "string")
              throw new Error("Expected a JSON request body");
            requests.push({
              url: String(input),
              body: JSON.parse(init.body) as Record<string, unknown>,
            });
            return successfulResponsesStream();
          },
        },
      );
      const eventTypes: string[] = [];
      for await (const event of stream) eventTypes.push(event.type);

      expect(eventTypes.at(-1)).toBe("done");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
      expect(requests[0]?.body.input).toEqual([
        ...REPLACEMENT_HISTORY,
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "next request after persisted compaction",
            },
          ],
        },
      ]);
    } finally {
      await resumed.close();
    }
  });
});

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

  liveTest(
    "produces model leaf/root summaries (not deterministic fallback) on Spark",
    async () => {
      const { session, status } = await createLiveLcmSession(SPARK);
      try {
        await addTurnAndCompact(session, status, "SPARK_MODEL_SUMMARY");
        // GAP-006 closure: the leaf/root calls go through the registry's
        // auth-retry resolver, so a stale OAuth bearer is refreshed instead
        // of degrading every summary to the deterministic fallback.
        expect(status.lastSummaryQuality).toBe("model");
        expect(status.lastCompletedModelSummaryCount).toBeGreaterThan(0);
        expect(status.lastDeterministicFallbackCount).toBe(0);
        expect(status.lastLeafModelError).toBeUndefined();
        expect(status.lastRootModelError).toBeUndefined();
        expect(status.lastNativeReplayStatus).toBe("preserved");
      } finally {
        await session.dispose();
      }
    },
    300_000,
  );
});
