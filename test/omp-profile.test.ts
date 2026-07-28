import { describe, expect, test } from "bun:test";
import packageMetadata from "../package.json" with { type: "json" };
import { createLcmExtension } from "../src/index.ts";
import { artifactStore, fakeModel } from "./helpers.ts";

type RegisteredTool = {
  name: string;
  execute?: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ) => unknown;
};

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
    const tools = new Map<string, RegisteredTool>();
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
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
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
    expect(tools.has("lcm_expand")).toBe(true);
    expect(typeof tools.get("lcm_expand")?.execute).toBe("function");
    const artifactPath = "/tmp/omp-lcm-profile-artifact-41";
    await Bun.write(
      artifactPath,
      JSON.stringify({
        schema: "omp-lcm-node/v1",
        kind: "leaf-summary",
        level: 0,
        summary: "runtime expansion succeeded",
        children: [],
        rawSources: [],
      }),
    );
    const expandResult = await tools
      .get("lcm_expand")
      ?.execute?.(
        "tool-call",
        { artifactId: "41", depth: 2, includeRaw: true },
        undefined,
        undefined,
        {
          ...context,
          sessionManager: { getArtifactPath: () => artifactPath },
        },
      );
    expect(expandResult).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Node artifact://41 [leaf-summary, level 0]",
            "Summary: runtime expansion succeeded",
            "Exact content: use read artifact://ID or read artifact://ID:<range>; search with grep against artifact URIs.",
          ].join("\n"),
        },
      ],
    });
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
      "dump ",
      "version ",
      "renderer ",
    ]);
    const renderers = command.getArgumentCompletions?.("renderer c");
    expect(renderers?.map((item) => item.value)).toEqual([
      "renderer context-full ",
    ]);
    const version = await command.handler("version", context);
    expect(version).toBe(
      `omp-lcm-inspired-compaction v${packageMetadata.version}`,
    );
    controller.status.lastOutcome = "success";
    controller.status.lastRoots = [
      {
        artifactId: "41",
        level: 0,
        sourceEntryCount: 1,
        tokenCount: 6,
      },
    ];
    const runtimeContext = {
      ...context,
      sessionManager: { getArtifactPath: () => artifactPath },
    };
    const status = await command.handler("status", runtimeContext);
    expect(status).toContain('"lastOutcome": "success"');
    expect(status).not.toContain("LCM DAG");
    const dump = await command.handler("dump", runtimeContext);
    expect(dump).toContain("LCM diagnostics:");
    expect(dump).toContain("LCM DAG (bounded to depth 8):");
    expect(dump).toContain("Node artifact://41 [leaf-summary, level 0]");
    expect(dump).toContain("Summary: runtime expansion succeeded");
    expect(notifications).toEqual([version, status, dump]);
  });
});
