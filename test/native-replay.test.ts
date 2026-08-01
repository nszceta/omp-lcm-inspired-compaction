import { describe, expect, test } from "bun:test";
import { createController } from "../src/controller.ts";
import { artifactStore, entry, event, preparation } from "./helpers.ts";

const userMessage = (content: string, timestamp: number) => ({
  role: "user" as const,
  content,
  timestamp,
});

interface TestOAuthAccess {
  accessToken: string;
  credentialId: number;
  accountId: string;
  orgId: string;
}

interface OpenAiTestContext {
  cwd: string;
  model: {
    id: string;
    provider: string;
    api: string;
    input: string[];
    contextWindow: number;
    baseUrl?: string;
    useResponsesLite?: boolean;
    remoteCompaction?: {
      v2StreamingEnabled?: boolean;
    };
  };
  sessionManager: Record<string, unknown>;
  modelRegistry: {
    getApiKey: () => Promise<string>;
    authStorage?: {
      getOAuthAccess: () => Promise<TestOAuthAccess>;
    };
  };
}

const openAiContext = (): OpenAiTestContext => ({
  cwd: "/tmp",
  model: {
    id: "gpt-replay",
    provider: "openai",
    api: "openai-responses",
    input: ["text"],
    contextWindow: 128_000,
  },
  sessionManager: artifactStore(),
  modelRegistry: { getApiKey: async () => "provider-key" },
});

const replayResponse = (encryptedContent: string) => ({
  provider: "openai",
  replacementHistory: [
    { type: "compaction", encrypted_content: encryptedContent },
  ],
  compactionItem: {
    type: "compaction" as const,
    encrypted_content: encryptedContent,
  },
});

describe("provider-native replay", () => {
  test("merges fresh OpenAI replacement history with LCM state", async () => {
    const context = openAiContext();
    const requests: Array<Array<Record<string, unknown>>> = [];
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async (_model, key, input) => {
        expect(key).toBe("provider-key");
        requests.push(input);
        return replayResponse("cipher-one");
      },
    });
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [userMessage("discarded first turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("discarded first turn");
    expect(result.compaction.preserveData.ompLcmArtifactsV1).toBeDefined();
    expect(
      result.compaction.preserveData.openaiRemoteCompaction.replacementHistory,
    ).toEqual([{ type: "compaction", encrypted_content: "cipher-one" }]);
    const lineage = result.compaction.preserveData.ompLcmNativeReplayLineageV1;
    expect(lineage).toMatchObject({
      version: 1,
      provider: "openai",
      modelId: "gpt-replay",
      apiVariant: "openai-responses:standard",
      endpoint: "https://api.openai.com/v1/responses/compact",
    });
    expect(lineage.credentialIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(lineage)).not.toContain("provider-key");
    expect(controller.status.lastNativeReplayStatus).toBe("preserved");
    expect(controller.status.lastNativeReplayProvider).toBe("openai");
    expect(controller.status.lastNativeReplayItemCount).toBe(1);
    expect(controller.status.lastNativeReplaySeeded).toBe(false);
  });

  test("forwards the session id on the direct v1 compaction request", async () => {
    const context = openAiContext();
    context.sessionManager = {
      ...artifactStore(),
      getSessionId: () => "session-v1",
    };
    const sessionIds: Array<string | undefined> = [];
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async (
        _model,
        _key,
        _input,
        _instructions,
        _signal,
        options,
      ) => {
        sessionIds.push(options?.sessionId);
        return replayResponse("cipher-v1-session");
      },
    });
    await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [userMessage("discarded first turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(sessionIds).toEqual(["session-v1"]);
    expect(controller.status.lastNativeReplayStatus).toBe("preserved");
  });

  test("notifies when native replay fails and keeps the LCM result", async () => {
    const context = openAiContext();
    const notifications: string[] = [];
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      notify: (message) => notifications.push(message),
      requestNativeCompaction: async () => {
        throw new Error("replay endpoint exploded");
      },
    });
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [userMessage("discarded first turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(result.compaction).toBeDefined();
    expect(controller.status.lastNativeReplayStatus).toBe("failed");
    expect(controller.status.lastNativeReplayError).toBe(
      "replay endpoint exploded",
    );
    expect(notifications.some((m) => m.includes("native replay failed"))).toBe(
      true,
    );
    expect(notifications.some((m) => m.includes("replay endpoint exploded"))).toBe(
      true,
    );
  });

  test("persists the run diagnostics as a session custom entry", async () => {
    const context = openAiContext();
    const customEntries: Array<{ customType: string; data: unknown }> = [];
    context.sessionManager = {
      ...artifactStore(),
      appendCustomEntry: (customType: string, data: unknown) => {
        customEntries.push({ customType, data });
        return "custom-1";
      },
    };
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async () => replayResponse("cipher-persist"),
    });
    await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [userMessage("discarded first turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]?.customType).toBe("lcm-status");
    const persisted = customEntries[0]?.data as {
      version?: number;
      status?: { lastOutcome?: string; lastNativeReplayStatus?: string };
    };
    expect(persisted.version).toBe(1);
    expect(persisted.status?.lastOutcome).toBe("success");
    expect(persisted.status?.lastNativeReplayStatus).toBe("preserved");
  });

  test("delegates V2 replay to OMP's streaming compaction orchestrator", async () => {
    const context = openAiContext();
    context.model.remoteCompaction = { v2StreamingEnabled: true };
    let nativeCalls = 0;
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      nativeCompact: async (
        nativePreparation,
        _model,
        key,
        _instructions,
        _signal,
        options,
      ) => {
        nativeCalls++;
        expect(key).toBe("provider-key");
        expect(String(options?.thinkingLevel)).toBe("low");
        expect(
          nativePreparation.previousPreserveData?.openaiRemoteCompaction,
        ).toBeUndefined();
        return {
          summary: "unused native summary",
          firstKeptEntryId: "keep",
          tokensBefore: 10,
          preserveData: {
            openaiRemoteCompaction: {
              version: "v2",
              provider: "openai",
              replacementHistory: [
                { type: "compaction", encrypted_content: "v2-cipher" },
              ],
              usedTokens: 8,
              retainedImageCount: 0,
            },
          },
        };
      },
    });
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          previousPreserveData: {
            openaiRemoteCompaction: replayResponse("stale-v1"),
          },
          messagesToSummarize: [userMessage("discarded first turn", 1)],
          settings: {
            strategy: "context-full",
            remoteEnabled: true,
            remoteStreamingV2Enabled: true,
          },
        }),
        [
          { type: "thinking_level_change", thinkingLevel: "low" },
          entry("old", "source detail ".repeat(100)),
          entry("keep"),
        ],
      ),
    );
    expect(nativeCalls).toBe(1);
    expect(
      result.compaction.preserveData.openaiRemoteCompaction.replacementHistory,
    ).toEqual([{ type: "compaction", encrypted_content: "v2-cipher" }]);
    expect(
      result.compaction.preserveData.ompLcmNativeReplayLineageV1,
    ).toMatchObject({
      apiVariant: "openai-responses:standard:streaming-v2",
      endpoint: "https://api.openai.com/v1/responses",
    });
    expect(controller.status.lastNativeReplayStatus).toBe("preserved");
  });

  test("records and seeds OMP's V1 fallback for a V2-eligible model", async () => {
    const context = openAiContext();
    context.model.remoteCompaction = { v2StreamingEnabled: true };
    let nativeCalls = 0;
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      nativeCompact: async (nativePreparation) => {
        nativeCalls++;
        if (nativeCalls === 1) {
          expect(
            nativePreparation.previousPreserveData?.openaiRemoteCompaction,
          ).toBeUndefined();
        } else {
          expect(
            JSON.stringify(
              nativePreparation.previousPreserveData?.openaiRemoteCompaction,
            ),
          ).toContain("fallback-1");
        }
        return {
          summary: "unused native summary",
          firstKeptEntryId: `keep-${nativeCalls}`,
          tokensBefore: 10,
          preserveData: {
            openaiRemoteCompaction: replayResponse(`fallback-${nativeCalls}`),
          },
        };
      },
    });
    const first = await controller.beforeCompact(
      event(
        preparation("keep-1", {
          messagesToSummarize: [userMessage("first discarded turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old-1", "first source ".repeat(100)), entry("keep-1")],
      ),
    );
    const second = await controller.beforeCompact(
      event(
        preparation("keep-2", {
          previousPreserveData: first.compaction.preserveData,
          messagesToSummarize: [userMessage("second discarded turn", 2)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [
          {
            type: "compaction",
            id: "c1",
            preserveData: first.compaction.preserveData,
          },
          entry("old-2", "second source ".repeat(100)),
          entry("keep-2"),
        ],
      ),
    );
    expect(nativeCalls).toBe(2);
    expect(
      second.compaction.preserveData.ompLcmNativeReplayLineageV1,
    ).toMatchObject({
      apiVariant: "openai-responses:standard",
      endpoint: "https://api.openai.com/v1/responses/compact",
    });
    expect(controller.status.lastNativeReplaySeeded).toBe(true);
  });

  test("seeds the next compaction with compatible replacement history", async () => {
    const context = openAiContext();
    const requests: Array<Array<Record<string, unknown>>> = [];
    let requestNumber = 0;
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async (_model, _key, input) => {
        requests.push(input);
        requestNumber++;
        return replayResponse(`cipher-${requestNumber}`);
      },
    });
    const first = await controller.beforeCompact(
      event(
        preparation("keep-1", {
          messagesToSummarize: [userMessage("first discarded turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old-1", "first source ".repeat(100)), entry("keep-1")],
      ),
    );
    const previousPreserveData = first.compaction.preserveData;
    const second = await controller.beforeCompact(
      event(
        preparation("keep-2", {
          previousPreserveData,
          messagesToSummarize: [userMessage("second discarded turn", 2)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [
          { type: "compaction", id: "c1", preserveData: previousPreserveData },
          entry("old-2", "second source ".repeat(100)),
          entry("keep-2"),
        ],
      ),
    );
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("cipher-1");
    expect(JSON.stringify(requests[1])).toContain("second discarded turn");
    expect(
      second.compaction.preserveData.openaiRemoteCompaction.replacementHistory,
    ).toEqual([{ type: "compaction", encrypted_content: "cipher-2" }]);
    expect(controller.status.lastNativeReplaySeeded).toBe(true);
    expect(controller.status.lastGeneration).toBe(2);
  });

  test("tracks OAuth account identity without resetting for token refresh", async () => {
    const context = openAiContext();
    let oauth = {
      accessToken: "oauth-token-a",
      credentialId: 7,
      accountId: "account-a",
      orgId: "workspace-a",
    };
    context.modelRegistry = {
      getApiKey: async () => oauth.accessToken,
      authStorage: { getOAuthAccess: async () => oauth },
    };
    const requests: Array<Array<Record<string, unknown>>> = [];
    let requestNumber = 0;
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async (_model, _key, input) => {
        requests.push(input);
        requestNumber++;
        return replayResponse(`cipher-${requestNumber}`);
      },
    });
    const compact = async (
      round: number,
      previousPreserveData?: Record<string, unknown>,
    ) =>
      controller.beforeCompact(
        event(
          preparation(`oauth-keep-${round}`, {
            previousPreserveData,
            messagesToSummarize: [
              userMessage(`oauth discarded turn ${round}`, round),
            ],
            settings: { strategy: "context-full", remoteEnabled: true },
          }),
          [
            ...(previousPreserveData
              ? [
                  {
                    type: "compaction",
                    id: `oauth-c-${round}`,
                    preserveData: previousPreserveData,
                  },
                ]
              : []),
            entry(`oauth-old-${round}`, "oauth source ".repeat(100)),
            entry(`oauth-keep-${round}`),
          ],
        ),
      );

    const first = await compact(1);
    expect(JSON.stringify(first.compaction.preserveData)).not.toContain(
      "oauth-token-a",
    );
    oauth = { ...oauth, accessToken: "oauth-token-refreshed" };
    const second = await compact(2, first.compaction.preserveData);
    expect(JSON.stringify(requests[1])).toContain("cipher-1");
    expect(controller.status.lastNativeReplaySeeded).toBe(true);

    oauth = {
      accessToken: "oauth-token-account-b",
      credentialId: 8,
      accountId: "account-b",
      orgId: "workspace-b",
    };
    await compact(3, second.compaction.preserveData);
    expect(JSON.stringify(requests[2])).not.toContain("cipher-2");
    expect(JSON.stringify(requests[2])).toContain("oauth discarded turn 3");
    expect(controller.status.lastNativeReplaySeeded).toBe(false);
  });

  test("starts a new lineage when any replay-bound configuration changes", async () => {
    const cases: Array<{
      name: string;
      mutate: (
        context: OpenAiTestContext,
        setKey: (key: string) => void,
      ) => void;
    }> = [
      {
        name: "model ID",
        mutate: (context) => {
          context.model.id = "gpt-replay-next";
        },
      },
      {
        name: "API variant",
        mutate: (context) => {
          context.model.api = "openai-codex-responses";
        },
      },
      {
        name: "Responses Lite variant",
        mutate: (context) => {
          context.model.useResponsesLite = true;
        },
      },
      {
        name: "endpoint",
        mutate: (context) => {
          context.model.baseUrl = "https://other.example/v1";
        },
      },
      {
        name: "credential identity",
        mutate: (_context, setKey) => setKey("provider-key-account-b"),
      },
    ];

    for (const item of cases) {
      const context = openAiContext();
      context.model.baseUrl = "https://api.openai.com/v1/";
      let key = "provider-key-account-a";
      context.modelRegistry.getApiKey = async () => key;
      const requests: Array<Array<Record<string, unknown>>> = [];
      let requestNumber = 0;
      const controller = createController(context, {
        summaryCall: async () => "local semantic summary",
        requestNativeCompaction: async (_model, _key, input) => {
          requests.push(input);
          requestNumber++;
          return replayResponse(`cipher-${requestNumber}`);
        },
      });
      const first = await controller.beforeCompact(
        event(
          preparation(`keep-1-${item.name}`, {
            messagesToSummarize: [userMessage("first lineage turn", 1)],
            settings: { strategy: "context-full", remoteEnabled: true },
          }),
          [
            entry(`old-1-${item.name}`, "first source ".repeat(100)),
            entry(`keep-1-${item.name}`),
          ],
        ),
      );
      const previousPreserveData = first.compaction.preserveData;
      item.mutate(context, (nextKey) => {
        key = nextKey;
      });
      const second = await controller.beforeCompact(
        event(
          preparation(`keep-2-${item.name}`, {
            previousPreserveData,
            messagesToSummarize: [userMessage("fresh lineage turn", 2)],
            settings: { strategy: "context-full", remoteEnabled: true },
          }),
          [
            {
              type: "compaction",
              id: `c-${item.name}`,
              preserveData: previousPreserveData,
            },
            entry(`old-2-${item.name}`, "second source ".repeat(100)),
            entry(`keep-2-${item.name}`),
          ],
        ),
      );
      expect(JSON.stringify(requests[1]), item.name).not.toContain("cipher-1");
      expect(JSON.stringify(requests[1]), item.name).toContain(
        "fresh lineage turn",
      );
      expect(second.compaction.summary, item.name).toContain(
        "Retained LCM history",
      );
      expect(controller.status.lastNativeReplaySeeded, item.name).toBe(false);
    }
  });

  test("does not trust legacy same-provider replay without lineage", async () => {
    const context = openAiContext();
    let nativeInput: Array<Record<string, unknown>> = [];
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async (_model, _key, input) => {
        nativeInput = input;
        return replayResponse("fresh-cipher");
      },
    });
    await controller.beforeCompact(
      event(
        preparation("keep", {
          previousPreserveData: {
            openaiRemoteCompaction: replayResponse("legacy-cipher"),
          },
          messagesToSummarize: [userMessage("fresh turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(JSON.stringify(nativeInput)).not.toContain("legacy-cipher");
    expect(JSON.stringify(nativeInput)).toContain("fresh turn");
    expect(controller.status.lastNativeReplaySeeded).toBe(false);
  });

  test("does not seed history from a different provider", async () => {
    const context = openAiContext();
    let nativeInput: Array<Record<string, unknown>> = [];
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async (_model, _key, input) => {
        nativeInput = input;
        return replayResponse("fresh-cipher");
      },
    });
    await controller.beforeCompact(
      event(
        preparation("keep", {
          previousPreserveData: {
            openaiRemoteCompaction: {
              provider: "openai-codex",
              replacementHistory: [
                { type: "compaction", encrypted_content: "stale-cipher" },
              ],
              compactionItem: {
                type: "compaction",
                encrypted_content: "stale-cipher",
              },
            },
          },
          messagesToSummarize: [userMessage("fresh turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(JSON.stringify(nativeInput)).not.toContain("stale-cipher");
    expect(JSON.stringify(nativeInput)).toContain("fresh turn");
    expect(controller.status.lastNativeReplaySeeded).toBe(false);
  });

  test("keeps textual LCM output and drops stale replay on remote failure", async () => {
    const context = openAiContext();
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async () => {
        throw new Error("remote replay unavailable");
      },
    });
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          previousPreserveData: {
            openaiRemoteCompaction: replayResponse("stale-cipher"),
          },
          messagesToSummarize: [userMessage("fresh turn", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(result.compaction.summary).toContain("Retained LCM history");
    expect(result.compaction.preserveData.ompLcmArtifactsV1).toBeDefined();
    expect(
      result.compaction.preserveData.openaiRemoteCompaction,
    ).toBeUndefined();
    expect(controller.status.lastNativeReplayStatus).toBe("failed");
    expect(controller.status.lastNativeReplayError).toContain(
      "remote replay unavailable",
    );
  });

  test("does not request replay when remote compaction is disabled", async () => {
    const context = openAiContext();
    let calls = 0;
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async () => {
        calls++;
        return replayResponse("unused");
      },
    });
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [userMessage("discarded", 1)],
          settings: { strategy: "context-full", remoteEnabled: false },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(result.compaction).toBeDefined();
    expect(calls).toBe(0);
    expect(controller.status.lastNativeReplayStatus).toBe("disabled");
  });

  test("does not request replay for an incompatible model", async () => {
    const context = {
      ...openAiContext(),
      model: {
        id: "anthropic-model",
        provider: "anthropic",
        api: "anthropic-messages",
        input: ["text"],
      },
    };
    let calls = 0;
    const controller = createController(context, {
      summaryCall: async () => "local semantic summary",
      requestNativeCompaction: async () => {
        calls++;
        return replayResponse("unused");
      },
    });
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          messagesToSummarize: [userMessage("discarded", 1)],
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old", "source detail ".repeat(100)), entry("keep")],
      ),
    );
    expect(result.compaction).toBeDefined();
    expect(calls).toBe(0);
    expect(controller.status.lastNativeReplayStatus).toBe("ineligible");
  });
});
