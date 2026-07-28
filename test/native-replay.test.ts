import { describe, expect, test } from "bun:test";
import { createController } from "../src/controller.ts";
import { artifactStore, entry, event, preparation } from "./helpers.ts";

const userMessage = (content: string, timestamp: number) => ({
  role: "user" as const,
  content,
  timestamp,
});

const openAiContext = () => ({
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
    expect(controller.status.lastNativeReplayStatus).toBe("preserved");
    expect(controller.status.lastNativeReplayProvider).toBe("openai");
    expect(controller.status.lastNativeReplayItemCount).toBe(1);
    expect(controller.status.lastNativeReplaySeeded).toBe(false);
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
