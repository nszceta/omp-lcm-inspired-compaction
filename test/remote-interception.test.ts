import { describe, expect, test } from "bun:test";
import { createController } from "../src/controller.ts";
import {
  artifactStore,
  entry,
  event,
  expectCancel,
  preparation,
} from "./helpers.ts";

describe("remote interception", () => {
  test("remote-enabled context-full returns extension result without fallthrough", async () => {
    let remoteCalls = 0;
    const ctx: any = {
      cwd: "/tmp",
      model: { input: ["text"] },
      sessionManager: artifactStore(),
      modelRegistry: { getApiKey: async () => "key" },
      remote: async () => {
        remoteCalls++;
        throw new Error("remote called");
      },
    };
    const controller = createController(ctx, {
      summaryCall: async () => "deterministic summary",
    });
    const result = await controller.beforeCompact(
      event(
        preparation("keep", {
          settings: { strategy: "context-full", remoteEnabled: true },
        }),
        [entry("old"), entry("keep")],
      ),
    );
    expect(result.compaction).toBeDefined();
    expect(remoteCalls).toBe(0);
  });
  test("artifact failure cancels rather than falling through", async () => {
    const ctx: any = {
      model: { input: ["text"] },
      sessionManager: {
        saveArtifact: async () => {
          throw new Error("artifact failure");
        },
      },
    };
    const controller = createController(ctx, {
      summaryCall: async () => "summary",
    });
    expectCancel(
      await controller.beforeCompact(
        event(preparation("keep", { settings: { remoteEnabled: true } }), [
          entry("old"),
          entry("keep"),
        ]),
      ),
    );
  });
});
