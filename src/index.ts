import packageMetadata from "../package.json" with { type: "json" };
import { persistRenderer, type Renderer } from "./config.ts";
import { PLUGIN_NAME } from "./contracts.ts";
import {
  type ControllerDeps,
  createController,
  type LcmController,
} from "./controller.ts";
import { createLcmExpandHandler, registerLcmExpandTool } from "./tools.ts";

export const PLUGIN_VERSION = packageMetadata.version;
export interface LcmExtensionOptions {
  deps?: ControllerDeps;
  context?: any;
}

/** Build an extension registration function with injectable seams for tests. */
export function createLcmExtension(options: LcmExtensionOptions = {}) {
  return (api: any, context?: any): LcmController =>
    registerExtension(
      api,
      context ?? options.context ?? api,
      options.deps ?? {},
    );
}
export const createExtension = createLcmExtension;

const LCM_HELP = [
  "LCM commands:",
  "  /lcm status                 Show renderer, generation, roots, and outcome.",
  "  /lcm dump                   Show diagnostics and the artifact-backed DAG.",
  "  /lcm version                Show the currently running plugin version.",
  "  /lcm renderer auto          Select automatically.",
  "  /lcm renderer context-full  Use text roots.",
  "  /lcm renderer snapcompact   Use summary-only snapcompact (vision model required).",
  "  /lcm help                   Show this help.",
  "Use the lcm_expand tool, read artifact://ID, and grep artifact://ID to retrieve archived history.",
].join("\n");

const LCM_COMPLETIONS = [
  { value: "help ", label: "help", description: "Show LCM command help" },
  { value: "status ", label: "status", description: "Show LCM runtime status" },
  { value: "dump ", label: "dump", description: "Show compaction diagnostics" },
  {
    value: "version ",
    label: "version",
    description: "Show the running plugin version",
  },
  {
    value: "renderer ",
    label: "renderer",
    description: "Choose the active root renderer",
  },
];

const RENDERER_COMPLETIONS = ["auto", "context-full", "snapcompact"].map(
  (value) => ({
    value: `renderer ${value} `,
    label: value,
    description: `Use ${value} rendering`,
  }),
);

export function registerExtension(
  api: any,
  ctx: any,
  deps: ControllerDeps = {},
) {
  const runtimeStatus = deps.status ?? {};
  let controller: LcmController | undefined;
  const ensure = (runtimeContext = ctx): LcmController =>
    (controller ??= createController(runtimeContext, {
      ...deps,
      status: runtimeStatus,
    }));
  if (typeof api.registerTool === "function") registerLcmExpandTool(api, ctx);
  api.on?.("session_before_compact", (event: any, eventContext: any) =>
    ensure(eventContext).beforeCompact(event),
  );
  const command = async (
    args: string | { args?: string } = "",
    commandContext?: any,
  ) => {
    const runtimeContext = commandContext ?? ctx;
    const notify = (
      message: string,
      type: "info" | "warning" | "error" = "info",
    ) => commandContext?.ui?.notify?.(message, type) ?? deps.notify?.(message);
    const text = typeof args === "string" ? args : (args.args ?? "");
    const words = text.trim().split(/\s+/u).filter(Boolean);
    let output: string;
    if (words[0] === "help" || words.length === 0) {
      output = LCM_HELP;
    } else if (words[0] === "version") {
      output = `${PLUGIN_NAME} v${PLUGIN_VERSION}`;
    } else if (words[0] === "status") {
      output = JSON.stringify(ensure(runtimeContext).status, null, 2);
    } else if (words[0] === "dump") {
      const status = ensure(runtimeContext).status;
      const roots = status.lastRoots ?? [];
      const expand = createLcmExpandHandler(undefined, {
        summaryLimit: 240,
        singleLineSummaries: true,
      });
      const dag =
        roots.length === 0
          ? "(no roots recorded)"
          : (
              await Promise.all(
                roots.map((root) =>
                  expand(
                    {
                      artifactId: root.artifactId,
                      depth: 8,
                      includeRaw: false,
                    },
                    runtimeContext,
                  ),
                ),
              )
            ).join("\n\n");
      output = [
        "LCM diagnostics:",
        JSON.stringify(status, null, 2),
        "",
        "LCM DAG (bounded to depth 8):",
        dag,
      ].join("\n");
    } else if (words[0] === "renderer" && words[1]) {
      const renderer = words[1] as Renderer;
      if (!["auto", "context-full", "snapcompact"].includes(renderer)) {
        output = "renderer must be auto, context-full, or snapcompact";
      } else {
        try {
          await persistRenderer(
            runtimeContext,
            renderer,
            runtimeContext.pluginManager ?? api.pluginManager,
          );
          output = `renderer=${renderer}`;
        } catch (error) {
          output = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    } else {
      output = `Unknown LCM command. Try /lcm help.\n\n${LCM_HELP}`;
    }
    notify(output, output.startsWith("error:") ? "error" : "info");
    return output;
  };
  api.registerCommand?.("lcm", {
    description: "LCM compaction status, renderer settings, and help",
    getArgumentCompletions: (argumentPrefix: string) => {
      const prefix = argumentPrefix.toLowerCase();
      if (prefix.startsWith("renderer ")) {
        const rendererPrefix = prefix.slice("renderer ".length);
        const matches = RENDERER_COMPLETIONS.filter((item) =>
          item.label.startsWith(rendererPrefix),
        );
        return matches.length > 0 ? matches : null;
      }
      if (prefix.includes(" ")) return null;
      const matches = LCM_COMPLETIONS.filter((item) =>
        item.label.startsWith(prefix.trim()),
      );
      return matches.length > 0 ? matches : null;
    },
    handler: command,
  });
  return {
    beforeCompact: (event: any) => ensure().beforeCompact(event),
    status: runtimeStatus,
  };
}

/** Default OMP extension export. Registration is side-effect free until invoked by OMP. */
export default function ompLcmExtension(api: any, context?: any) {
  return registerExtension(api, context ?? api, {});
}
export * from "./contracts.ts";
export * from "./controller.ts";
export { PLUGIN_NAME };
