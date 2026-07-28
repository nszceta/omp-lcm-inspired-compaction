import { describe, expect, test } from "bun:test";
import { createController } from "../src/controller.ts";
import {
  artifactStore,
  entry,
  event,
  expectCancel,
  preparation,
} from "./helpers.ts";

describe("controller", () => {
  function ctx(model: any = { input: ["text"] }) {
    return {
      cwd: "/tmp",
      model,
      sessionManager: artifactStore(),
      modelRegistry: { getApiKey: async () => "key" },
    };
  }
  test("returns complete context-full result and status", async () => {
    const c = ctx();
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    const result = await controller.beforeCompact(
      event(preparation("keep", { messagesToSummarize: ["discarded"] }), [
        entry("old"),
        entry("keep"),
      ]),
    );
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("keep");
    expect(controller.status.lastOutcome).toBe("success");
  });
  test("fails closed on boundary and abort", async () => {
    const c = ctx();
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    expectCancel(
      await controller.beforeCompact(
        event(preparation("missing"), [entry("a")]),
      ),
    );
    const ac = new AbortController();
    ac.abort();
    expectCancel(
      await controller.beforeCompact(
        event(preparation("a"), [entry("a")], { signal: ac.signal }),
      ),
    );
  });
  test("selects snapcompact for vision model", async () => {
    const c = ctx({ input: ["text", "image"] });
    const controller = createController(c, {
      summaryCall: async () => "summary",
    });
    const result = await controller.beforeCompact(
      event(preparation("keep", { settings: { strategy: "snapcompact" } }), [
        entry("old"),
        entry("keep"),
      ]),
    );
    expect(result).not.toBeUndefined();
  });
});
