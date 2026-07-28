import { describe, expect, test } from "bun:test";
import { createLcmExtension } from "../src/index.ts";
import { artifactStore, fakeModel } from "./helpers.ts";

describe("custom OMP test profile", () => {
  test("loads standalone extension and exposes working slash commands", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands = new Map<
      string,
      {
        handler: (args: string, ctx: unknown) => Promise<string>;
        getArgumentCompletions?: (
          prefix: string,
        ) => Array<{ value: string; label: string }> | null;
      }
    >();
    const api = {
      on(name: string, handler: (event: unknown) => unknown) {
        handlers.set(name, handler);
      },
      registerCommand(
        name: string,
        options: {
          handler: (args: string, ctx: unknown) => Promise<string>;
          getArgumentCompletions?: (
            prefix: string,
          ) => Array<{ value: string; label: string }> | null;
        },
      ) {
        commands.set(name, options);
      },
    };
    const notifications: string[] = [];
    const context = {
      cwd: "/tmp/omp-lcm-profile",
      model: fakeModel(false),
      sessionManager: artifactStore(),
      modelRegistry: { getApiKey: async () => "profile-key" },
      ui: { notify: (message: string) => notifications.push(message) },
    };
    const controller = createLcmExtension({
      deps: { summaryCall: async () => "profile summary" },
    })(api, context);
    expect(controller.status).toEqual({});
    expect(handlers.has("session_before_compact")).toBe(true);
    expect(commands.has("lcm")).toBe(true);
    const command = commands.get("lcm");
    expect(command).toBeDefined();
    if (!command) throw new Error("lcm command was not registered");
    const topLevel = command.getArgumentCompletions?.("");
    expect(topLevel?.map((item) => item.value)).toEqual([
      "help ",
      "status ",
      "renderer ",
    ]);
    const renderers = command.getArgumentCompletions?.("renderer c");
    expect(renderers?.map((item) => item.value)).toEqual([
      "renderer context-full ",
    ]);
    const status = await command.handler("status", context);
    expect(status).toBe("{}");
    expect(notifications).toEqual(["{}"]);
  });
});
