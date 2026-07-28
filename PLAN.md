# PLAN: Standalone Artifact-Backed LCM Compaction Plugin for Oh My Pi

## Supervisory instruction

You are the implementation supervisor. Work only in the repository containing this file:

```text
~/src/nszceta/omp-lcm-inspired-compaction/
```

All delivered plugin code, package metadata, tests, fixtures, documentation, and marketplace metadata must live in this repository. Do not create or edit files in an Oh My Pi source checkout. Do not place implementation files under `packages/coding-agent`, `packages/agent`, `packages/snapcompact`, or any other upstream directory.

Oh My Pi source may be read to verify public API behavior, but it is an external dependency and must remain unchanged. The standalone package must integrate through published/public OMP extension APIs and package dependencies.

Use Luna Medium workers and Luna Medium verifiers. Keep every delegated task small and mechanical:

- Give each worker the exact local files and fixed contracts from this document.
- A worker should own one small module and its unit test, or one narrow integration test.
- No worker may redesign the architecture or move implementation into OMP.
- No worker should modify more than three production files.
- Workers must skip formatters, project-wide typechecking, and the full test suite. The supervisor runs validation after integrating each wave.
- Run independent tasks in one concurrent wave. Never run more than eight workers at once.
- Use fresh read-only Luna Medium verifiers after implementation.
- Preserve unrelated repository changes.
- Do not weaken an assertion or skip a failing test to make validation pass.

The result is incomplete unless every acceptance criterion in this plan is satisfied.

---

## Required repository outcome

The finished repository must be a normal standalone OMP plugin package with this shape:

```text
omp-lcm-inspired-compaction/
├── .gitignore
├── .omp-plugin/
│   └── marketplace.json
├── LICENSE
├── PLAN.md
├── README.md
├── biome.json
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── contracts.ts
│   ├── source.ts
│   ├── summarize.ts
│   ├── dag.ts
│   ├── render-context-full.ts
│   ├── render-snapcompact.ts
│   ├── controller.ts
│   └── tools.ts
└── test/
    ├── helpers.ts
    ├── contracts.test.ts
    ├── source.test.ts
    ├── summarize.test.ts
    ├── dag.test.ts
    ├── render-context-full.test.ts
    ├── render-snapcompact.test.ts
    ├── controller.test.ts
    ├── remote-interception.test.ts
    ├── lifecycle.test.ts
    └── tools.test.ts
```

Minor fixture files under `test/fixtures/` are allowed. Do not introduce a monorepo, copy OMP source into this repository, use Git submodules, or require consumers to patch OMP.

The package entry point must be `./src/index.ts`. `package.json` must declare it through both `exports` and `omp.extensions`, following established standalone OMP plugin conventions.

---

## Product goal

Implement a loadable OMP extension that replaces ordinary `context-full` and `snapcompact` compaction with a practical Lossless Context Management system:

1. Preserve exact discarded OMP `SessionEntry` objects in session artifacts.
2. Generate concise summaries of bounded source chunks.
3. Insert `artifact://ID` references through deterministic code after summarization.
4. Store immutable leaf and parent summary nodes as artifacts.
5. Keep only a bounded set of root summaries in active context and compaction `preserveData`.
6. Keep every compacted source entry transitively reachable from a current root.
7. Render roots as plain text for context-full compaction.
8. Render roots through public `@oh-my-pi/snapcompact` for snapcompact compaction, ensuring snapcompact retains summaries and artifact IDs rather than raw historical transcript text.
9. Intercept built-in remote context-full compaction by returning a complete custom result from `session_before_compact` before OMP reaches its local, remote-endpoint, OpenAI V1, or OpenAI V2 compaction path.
10. Fail closed after accepting an event so errors cannot silently fall through to built-in remote compaction.
11. Provide a small `lcm_expand` tool for traversing node artifacts; ordinary OMP `read` and `grep` remain the source-retrieval tools.

This plugin implements the practical LCM invariants available through the current public OMP API. It does not claim exact parity with asynchronous or transactional features unavailable to a standalone extension.

---

## Non-negotiable standalone boundary

### Allowed

- Import public APIs from published OMP packages.
- Depend on `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-agent-core`, `@oh-my-pi/pi-ai`, and `@oh-my-pi/snapcompact` as required.
- Read upstream source or installed package source to confirm signatures.
- Use `session_before_compact`, `ExtensionContext.sessionManager`, plugin settings APIs, commands, flags, and `registerTool`.
- Build integration tests in this repository against the OMP package listed in `devDependencies`.

### Forbidden

- Editing an OMP checkout.
- Adding fields to `SessionBeforeCompactEvent` in OMP.
- Adding a new OMP compaction strategy enum.
- Adding tests to OMP’s test directories.
- Monkey-patching OMP or snapcompact internals.
- Patching HTTP clients to stop remote compaction.
- Depending on unpublished local relative imports such as `../oh-my-pi/packages/...`.
- Requiring users to copy files manually into the OMP package.

The remote interception mechanism is the existing custom compaction result. The plugin must not require any core change.

---

## OMP behavior this standalone plugin relies on

The following context is included so workers do not need to rediscover the architecture.

### Compaction hook

OMP emits `session_before_compact` for ordinary manual and automatic compaction. The event provides:

```ts
interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  signal: AbortSignal;
}
```

The preparation includes:

```ts
interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  recentMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  previousPreserveData?: Record<string, unknown>;
  fileOps: FileOperations;
  settings: CompactionSettings;
}
```

`preparation.settings` contains the effective invocation settings, including `strategy` and `remoteEnabled`. Manual `/compact soft`, `/compact remote`, and `/compact snapcompact` overrides are reflected in the preparation settings.

A handler may return:

```ts
{ cancel: true }
```

or:

```ts
{ compaction: CompactionResult }
```

A complete custom result causes OMP to install that result and skip its built-in snapcompact and context-full `compact()` calls. Skipping context-full `compact()` also skips:

- configured remote endpoint compaction;
- provider-native OpenAI V1 compaction;
- provider-native OpenAI V2 streaming compaction;
- built-in local summary fallback.

If the handler returns `undefined`, OMP resumes built-in compaction. Therefore this plugin must never return `undefined` after deciding to handle the event.

### Strategy selection without core changes

The event does not expose a separate final `action` field. The plugin must select its renderer using available public information:

1. Plugin setting `renderer=context-full`: always use text roots.
2. Plugin setting `renderer=snapcompact`: use snapcompact only if `ctx.model` accepts image input; otherwise cancel before writing artifacts.
3. Plugin setting `renderer=auto`:
   - use snapcompact when `preparation.settings.strategy === "snapcompact"`, the current model accepts image input, and `event.customInstructions` is absent;
   - otherwise use context-full.

This mirrors the relevant public behavior without changing OMP. An internal OMP guidance value is not exposed to extensions. Document that `renderer=auto` cannot observe hidden internal-guidance overrides; users needing deterministic behavior should set the plugin renderer explicitly.

Successful `handoff` and `shake` execute outside or before the ordinary custom compaction result path. They are not primary supported strategies. `off` emits no compaction. Document that automatic LCM requires OMP strategy `context-full` or `snapcompact`.

### Artifact API

`ExtensionContext.sessionManager` exposes public methods needed by the plugin:

- `saveArtifact(content, toolType)`
- `getArtifactPath(id)`
- `getArtifactManager()`
- `getBranch()` and other read-only session methods

Artifact IDs are numeric strings, sequential within a session, resume-safe, and shared by a parent/subagent tree. `artifact://ID` resolution is pinned to the calling session. Existing OMP tools support selectors and path-only search against artifacts.

Never predict an ID. Save first, receive the ID, validate it, then append the reference.

### Snapcompact API

Use the public package, not internal source paths:

```ts
import {
  archiveSourceText,
  compact,
  getPreservedArchive,
} from "@oh-my-pi/snapcompact";
```

Snapcompact normally unfolds its previous archive source and combines it with newly discarded history. The plugin must prevent raw-history replay by giving snapcompact a synthetic preparation whose messages contain only current LCM root summaries and references, and whose `previousPreserveData` contains only the plugin’s bounded LCM key.

OMP will reattach a valid returned snapcompact archive on later context rebuilds.

### Plugin settings API

Use standalone plugin metadata in `package.json` and public helpers:

```ts
import {
  getPluginSettings,
  PluginManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
```

Follow the same package-level pattern as other standalone OMP plugins: settings are declared under `package.json#omp.settings`, read using the plugin name and `ctx.cwd`, and changed through `PluginManager` when `/lcm renderer ...` is used.

---

## LCM invariants implemented by this plugin

The original LCM method distinguishes an immutable source store from active summaries. This plugin maps those concepts as follows:

| LCM concept | Standalone plugin implementation |
|---|---|
| Immutable message store | Exact JSONL session artifacts written before summary-node installation |
| Active context | Recent raw OMP messages plus bounded LCM root summaries |
| Leaf | Summary-node artifact pointing to one or more raw artifacts |
| Hierarchy | Parent node artifact pointing to child node artifact IDs |
| Stable identifier | Numeric session artifact ID rendered as `artifact://ID` |
| Deterministic retrievability | Plugin code appends root/source references after model output |
| Expansion | `lcm_expand` plus ordinary `read artifact://ID` |
| Exact search | Ordinary OMP grep/search against raw artifact URI/path |
| Guaranteed convergence | Normal, aggressive, then deterministic bounded fallback |

Required invariants:

- Summaries are derived views, never the sole source of truth.
- Every discarded source entry remains transitively reachable from an active root.
- The model is never responsible for copying an artifact ID correctly.
- Repeated compaction creates parent nodes rather than flattening and losing old provenance.
- Active root count and preserve-data size remain bounded.
- Failure after accepting a hook event cannot invoke built-in remote compaction.

Unavailable exact-paper features, explicitly out of scope:

- asynchronous soft-threshold compaction;
- atomic background summary installation;
- transactional commit spanning several artifact writes and OMP’s compaction entry;
- globally unique artifact IDs across sessions;
- automatic pre-handoff source injection;
- automatic shake-region summary callbacks.

Partial writes may leave orphan artifacts. The plugin must never install a node that references an artifact write that failed.

---

## Package contract

Create `package.json` with this minimum shape. Resolve the exact compatible version from the currently published/available OMP package before installation, but keep all OMP packages on the same compatible version range.

```json
{
  "name": "omp-lcm-inspired-compaction",
  "version": "0.1.0",
  "description": "Artifact-backed hierarchical LCM-inspired compaction for Oh My Pi",
  "type": "module",
  "license": "MIT",
  "files": ["src", "README.md", "LICENSE"],
  "exports": "./src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "check": "biome check .",
    "format": "biome format --write .",
    "pack": "bun pm pack"
  },
  "omp": {
    "extensions": ["./src/index.ts"],
    "settings": {
      "renderer": {
        "type": "enum",
        "description": "LCM root renderer",
        "values": ["auto", "context-full", "snapcompact"],
        "default": "auto"
      }
    }
  }
}
```

Dependency roles:

- `@oh-my-pi/pi-coding-agent`: peer and dev dependency; extension types, plugin settings, session API.
- `@oh-my-pi/pi-agent-core`: runtime dependency only if token counting or public compaction types are imported at runtime; otherwise dev/peer as appropriate.
- `@oh-my-pi/pi-ai`: runtime dependency for `complete()` and model/message types.
- `@oh-my-pi/snapcompact`: runtime dependency for summary-only snapcompact rendering.
- `typescript`, `@types/bun`, and `@biomejs/biome`: dev dependencies.

Do not add a dependency on a filesystem checkout. Produce and inspect `bun pm pack` output before completion; the tarball must contain the extension source and documentation and must not contain tests, local artifacts, sessions, or copied OMP source.

Create `.omp-plugin/marketplace.json` naming `nszceta/omp-lcm-inspired-compaction` as the GitHub source and repository.

---

## Fixed plugin data contracts

All workers must use these contracts. Do not reopen their design.

### Constants

```ts
export const PLUGIN_NAME = "omp-lcm-inspired-compaction";
export const LCM_PRESERVE_KEY = "ompLcmArtifactsV1";
export const MAX_ACTIVE_ROOTS = 4;
export const RAW_CHUNK_TARGET_TOKENS = 12_000;
export const ROOT_SUMMARY_TARGET_TOKENS = 2_048;
export const SNAPCOMPACT_MAX_FRAMES = 4;
```

For models with small context windows, lower raw summary chunks to no more than one eighth of `ctx.model.contextWindow`, with a minimum target of 2,048 and maximum of 12,000.

### Preserve state

```ts
export interface LcmPreserveStateV1 {
  version: 1;
  generation: number;
  roots: LcmRootRef[];
}

export interface LcmRootRef {
  artifactId: string;
  level: number;
  summary: string;
  sourceEntryCount: number;
  tokenCount: number;
}
```

Only current roots are stored in `preserveData`. Never persist the whole DAG or an ever-growing set of entry IDs there. Child provenance is stored inside immutable artifacts.

Parse previous state defensively from unknown input. Invalid version, invalid roots, nonnumeric IDs, or unreasonable values produce “no prior LCM state,” not a crash.

### Raw artifact

Tool type: `lcm-raw`.

Content: UTF-8 JSONL, one exact `JSON.stringify(sessionEntry)` per line. Do not rewrite roles, tool results, timestamps, IDs, or message content.

### Node artifact

Tool type: `lcm-node`.

```ts
export interface LcmNodeArtifactV1 {
  schema: "omp-lcm-node/v1";
  kind: "leaf-summary" | "condensed-summary" | "legacy-summary";
  level: number;
  summary: string;
  children: string[];
  rawSources: string[];
  sourceEntryIds: string[];
  sourceEntryCount: number;
  createdAt: string;
}
```

- IDs inside `children` and `rawSources` are numeric strings without `artifact://`.
- Leaf nodes point to raw artifacts and have no children.
- Condensed nodes point to child node artifacts.
- Legacy nodes map a pre-plugin `previousSummary` to raw artifacts captured on first activation.
- The model supplies only `summary` prose.
- Plugin code writes all ID arrays and model-visible retrieval lines.
- Tests ignore the exact `createdAt` value.

### Model-visible roots

Use a single deterministic formatter:

```text
## Retained LCM history

### Root 1
<summary prose>
Expand node: artifact://<node id>

### Root 2
<summary prose>
Expand node: artifact://<node id>

Retrieval: use `lcm_expand` for node structure, `read artifact://ID` for exact content, and grep/search against artifact URIs for exact matches.
```

Never place a raw list of many child IDs into active context. The root node artifact contains that list; active text needs only the root ID.

---

## Exact source-selection algorithm

Implement this in `src/source.ts` without changing OMP.

1. Locate `preparation.firstKeptEntryId` in `event.branchEntries`. If absent, return a typed boundary error.
2. Parse LCM state from `preparation.previousPreserveData?.[LCM_PRESERVE_KEY]`.
3. If valid prior LCM state exists, search backward before the keep boundary for the latest compaction entry whose preserve data contains the same LCM generation. Capture after that entry.
4. If no valid prior LCM state exists, capture from the beginning of the branch. This first run intentionally captures raw entries covered by earlier non-LCM compactions because OMP branch history still retains those entries.
5. End immediately before the keep boundary. This covers fully discarded messages and a discarded split-turn prefix.
6. Exclude prior compaction entries themselves from raw JSONL. Preserve conversational entries, tool results, custom messages, and branch summaries. Administrative entries may be omitted only when a focused unit test explicitly justifies the omission.
7. Never capture entries at or after `firstKeptEntryId`; those are recent active history.
8. Chunk the exact-entry slice in stable order by estimated serialized token count. Do not split one `SessionEntry` between raw artifacts.
9. Save every raw chunk before creating a node that references it.
10. Use `preparation.messagesToSummarize` plus `turnPrefixMessages` as the new LLM summary input. On first activation, also incorporate `preparation.previousSummary` as a legacy map for older already-compacted source.

If preparation contains discarded messages but source capture is empty, cancel. This is a boundary error, not permission to fall back to built-in compaction.

---

## Summary and convergence contract

Implement in `src/summarize.ts` with dependency injection for tests.

### Default model call

Use the current OMP model and its key:

```ts
const model = ctx.model;
const apiKey = await ctx.modelRegistry.getApiKey(model);
const response = await complete(model, request, {
  apiKey,
  maxTokens: target,
  signal: event.signal,
});
```

Follow the public API signature installed in this repository. Do not select a cheaper or different provider automatically. The user chose the active model.

The direct summary request may use a hosted model. “Remote interception” in this plan means disabling OMP’s built-in remote/provider-native compaction path, not eliminating all network traffic.

### Three levels

For every leaf or parent summary:

1. **Normal:** structured, detail-preserving summary targeting the requested token count.
2. **Aggressive:** terse bullet summary targeting half the normal count.
3. **Deterministic:** no LLM call; emit a bounded archival statement and optional bounded head/tail excerpt.

Measure the candidate after mandatory deterministic retrieval wording is added. Accept an LLM candidate only when it is smaller than input and within target. Two oversized, empty, errored, or non-shrinking attempts reach deterministic fallback.

Abort is different from summary failure. If the signal is aborted, stop and cancel; do not run further levels.

The deterministic level must always fit. If provenance would be long, store it in the node and expose only one root/node artifact reference.

Prompts must request these categories without requesting IDs:

- goals and user intent;
- decisions and rationale;
- files, symbols, commands, and observed results;
- errors, blockers, and unresolved risks;
- current state and next actions;
- facts needed to continue accurately.

Artifact IDs are appended after the response by deterministic code.

---

## DAG construction contract

Implement in `src/dag.ts`.

### Leaf generation

For each bounded new source chunk:

1. Save exact JSONL as `lcm-raw` and receive its numeric ID.
2. Summarize the corresponding bounded conversational text.
3. Save an `omp-lcm-node/v1` leaf containing summary prose, raw source IDs, and exact source entry IDs.
4. Receive the node artifact ID.
5. Add a root descriptor only after both writes succeed.

On first activation with a non-LCM `previousSummary`, create a legacy node whose summary is the previous summary and whose raw sources cover the older exact captured entries. Do not ask an LLM to recreate information already represented by the previous summary.

### Condensation

Combine prior roots and new roots in chronological order. While there are more than four roots or formatted roots exceed `ROOT_SUMMARY_TARGET_TOKENS`:

1. Take the oldest bounded group, at most four roots.
2. Summarize their prose without loading raw source.
3. Save a condensed node containing the child node artifact IDs.
4. Replace those roots with the new parent root.
5. Repeat until bounds hold.

The previous child nodes remain immutable and reachable. Preserve data contains only final roots.

### Write safety

Artifact writes and OMP compaction installation are not transactional. Enforce the safe direction:

- A failed raw write cannot produce a leaf.
- A failed leaf write cannot produce an active root.
- A failed parent write cannot replace its children.
- A later failure may orphan already-written artifacts, but the handler cancels and installs no partial state.

---

## Renderer contracts

### Context-full renderer

`src/render-context-full.ts` returns a complete OMP `CompactionResult`:

- `summary`: deterministic formatted roots;
- `shortSummary`: concise count of roots and archived source entries;
- `firstKeptEntryId`: copied exactly from preparation;
- `tokensBefore`: copied exactly from preparation;
- `details`: optional bounded LCM statistics;
- `preserveData`: exactly `{ [LCM_PRESERVE_KEY]: state }`.

Do not merge old snapcompact or provider-native remote preserve data. The resulting textual root is portable across providers.

### Snapcompact renderer

`src/render-snapcompact.ts` must:

1. Reject a non-vision model before writes when snapcompact is explicitly required.
2. Format current LCM roots.
3. Construct one synthetic text message containing only those roots and retrieval instructions.
4. Construct a public snapcompact preparation using original `firstKeptEntryId`, `tokensBefore`, and file operations, empty prefix messages, and no raw transcript messages.
5. Set synthetic `previousPreserveData` to exactly `{ [LCM_PRESERVE_KEY]: state }`.
6. Call public snapcompact `compact()` with `maxFrames: 4` and the active model.
7. Return the snapcompact result. Its preserve data must contain the new snapcompact archive plus the same LCM state.

Never pass `preparation.previousPreserveData` directly. That could unfold an old raw snapcompact archive or retain provider-native replacement history.

A second LCM snapcompact pass must reconstruct synthetic source from current roots and again omit the previous archive. Snapcompact must never rerasterize old raw transcript.

---

## Remote interception and fail-closed behavior

Implement in `src/controller.ts`.

### Event acceptance

The extension handles every `session_before_compact` event while loaded. It does not return `undefined`.

- Success: return `{ compaction: result }`.
- User abort: return `{ cancel: true }`.
- Missing model or API key: notify and return `{ cancel: true }`.
- Boundary or state error: notify and return `{ cancel: true }`.
- Artifact write failure: notify and return `{ cancel: true }`.
- Explicit snapcompact with non-vision model: notify and return `{ cancel: true }`.
- Model summary failure: escalate and use deterministic fallback; do not cancel unless aborted.
- Unexpected exception: notify, log, and return `{ cancel: true }`.

This guarantees OMP cannot continue to built-in local or remote compaction after the plugin accepts the event.

### Remote observability

Track bounded in-memory status for `/lcm status`:

```ts
interface LcmRuntimeStatus {
  lastRenderer?: "context-full" | "snapcompact";
  lastGeneration?: number;
  lastRootCount?: number;
  lastRemoteEnabledIntercepted?: boolean;
  lastOutcome?: "success" | "cancelled";
  lastError?: string;
}
```

Set `lastRemoteEnabledIntercepted` when the handled preparation has `settings.remoteEnabled !== false` and the selected renderer is context-full. Do not persist API keys, prompts, raw source, or unbounded errors in status.

### Settings and command

`src/config.ts` reads `renderer` from `getPluginSettings(PLUGIN_NAME, ctx.cwd)` and validates unknown values.

Register:

```text
/lcm status
/lcm renderer auto
/lcm renderer context-full
/lcm renderer snapcompact
```

Persist renderer changes through `PluginManager`. If persistence fails, report the error; do not pretend it was saved.

---

## Retrieval tool contract

Register one extension tool in `src/tools.ts`:

```text
lcm_expand
```

Parameters:

- `artifactId`: numeric string;
- `depth`: integer with a small maximum, default 1;
- `includeRaw`: boolean, default false.

Behavior:

1. Resolve through `ctx.sessionManager.getArtifactPath`; never scan other sessions.
2. Parse only `schema: "omp-lcm-node/v1"` as a node.
3. Emit node summary, `artifact://` child links, and `artifact://` raw source links.
4. Recursively inspect child nodes up to `depth`.
5. Detect cycles defensively.
6. Do not inline raw artifact content unless `includeRaw=true`.
7. Even with `includeRaw=true`, bound output and direct the model to `read artifact://ID:<range>` for large content.
8. On malformed or missing artifacts, return a useful error without throwing outside the tool.

Exact retrieval and search remain ordinary OMP operations:

```text
read artifact://17
read artifact://17:1-300
grep "validateToken" artifact://17
```

---

## Abort discipline

Pass `event.signal` to every summary call. Check it:

- before source selection;
- before each artifact write;
- immediately after each artifact write;
- before and after each LLM request;
- before parent condensation;
- before rendering;
- before returning the custom result.

An abort returns cancel. It never triggers deterministic fallback or built-in compaction.

---

## Implementation waves and Luna Medium tasks

The supervisor must create todos for every task below before implementation. Each task is intentionally narrow enough for Luna Medium.

### Wave 1 — Standalone package foundation

Run Tasks 1 and 2 concurrently.

#### Task 1: Create package and marketplace metadata

**Files:**

- `package.json`
- `.omp-plugin/marketplace.json`
- `.gitignore`

**Instructions:** Create the standalone package metadata described above. Use published compatible OMP package versions, all from the same release line. Declare `src/index.ts` as both export and OMP extension. Add renderer plugin setting. Ignore `node_modules`, build/coverage output, packed tarballs, local OMP/session state, and environment files.

**Acceptance:** `bun install` succeeds; OMP plugin metadata identifies `nszceta/omp-lcm-inspired-compaction`; no local filesystem dependency exists.

#### Task 2: Create TypeScript and Biome configuration

**Files:**

- `tsconfig.json`
- `biome.json`
- `LICENSE`

**Instructions:** Use strict TypeScript suitable for Bun ESM and `.ts` imports. Use repository-local formatting/lint configuration. Add the repository’s intended license text; do not copy an incompatible license.

**Acceptance:** An empty `src/index.ts` can typecheck once dependencies are installed; no path alias points into an OMP checkout.

### Wave 2 — Independent pure modules

Run Tasks 3, 4, and 5 concurrently after package setup.

#### Task 3: Implement contracts, parsing, and formatting

**Files:**

- `src/contracts.ts`
- `test/contracts.test.ts`

**Instructions:** Implement constants, data interfaces, safe previous-state parsing, numeric artifact ID validation, root formatter, artifact URI formatter, and renderer value parser.

**Acceptance:** Tests cover valid and invalid state, unknown versions, malformed roots, stable root order, numeric IDs, and deterministic reference lines.

#### Task 4: Implement exact source capture and chunk planning

**Files:**

- `src/source.ts`
- `test/source.test.ts`

**Instructions:** Implement the exact source-selection algorithm and JSONL chunk planning. Inject token counting and artifact saving so tests use fakes. Do not perform model calls or DAG condensation.

**Acceptance:** Tests cover first activation, repeated LCM generation, earlier non-LCM compaction, split-turn prefix, recent-entry exclusion, exact JSON round-trip, stable chunks, missing boundary, and abort.

#### Task 5: Implement three-level summarization

**Files:**

- `src/summarize.ts`
- `test/summarize.test.ts`

**Instructions:** Implement normal, aggressive, and deterministic convergence with injected model call and token counter. Keep model prose separate from deterministic retrieval text.

**Acceptance:** Tests prove normal success, aggressive escalation, deterministic fallback, output bound, non-shrinking rejection, empty/error handling, and abort propagation.

### Wave 3 — DAG and renderers

Run Tasks 6, 7, and 8 concurrently after Wave 2.

#### Task 6: Implement immutable DAG construction

**Files:**

- `src/dag.ts`
- `test/dag.test.ts`

**Instructions:** Save leaf and parent node artifacts through injected storage. Combine prior and new roots, condense oldest roots to four, and keep preserve state bounded.

**Acceptance:** Across at least ten simulated generations, every raw source is reachable, root order is stable, roots never exceed four, previous nodes are not mutated, write failures do not install invalid references, and serialized preserve state is bounded by active roots.

#### Task 7: Implement context-full result renderer

**Files:**

- `src/render-context-full.ts`
- `test/render-context-full.test.ts`

**Instructions:** Produce the complete textual compaction result and plugin-only preserve data. Seed tests with fake previous snapcompact, OpenAI V1, and V2 preserve keys and prove none survive.

**Acceptance:** Summary contains deterministic root links; boundary fields are preserved exactly; only the LCM preserve key remains.

#### Task 8: Implement summary-only snapcompact renderer

**Files:**

- `src/render-snapcompact.ts`
- `test/render-snapcompact.test.ts`

**Instructions:** Call public snapcompact over one synthetic root message. Supply only plugin state as previous preserve data. Cap frames at four. Make model and compact function injectable.

**Acceptance:** `archiveSourceText(getPreservedArchive(result.preserveData))` contains root summary markers and artifact links, excludes a unique raw-history sentinel and old archive sentinel, and a second pass does not unfold the first archive.

### Wave 4 — Controller, configuration, and tool

Run Tasks 9 and 10 concurrently after Wave 3.

#### Task 9: Implement controller and extension entry point

**Files:**

- `src/controller.ts`
- `src/config.ts`
- `src/index.ts`

**Instructions:** Assemble source capture, model summarization, DAG construction, renderer selection, settings, status command, and `session_before_compact`. Export a factory with dependency injection for tests; default export wires public OMP APIs. Implement fail-closed returns on every handled path.

**Acceptance:** The extension registers without side effects; settings are read per session/cwd; context-full and snapcompact paths return complete results; no accepted path returns undefined.

#### Task 10: Implement recursive expansion tool

**Files:**

- `src/tools.ts`
- `test/tools.test.ts`

**Instructions:** Implement the fixed `lcm_expand` contract using only the calling session’s artifact resolver. Keep output bounded and errors contained.

**Acceptance:** Tests cover a leaf, condensed parent, depth bounds, optional raw inclusion, missing artifact, malformed node, and cycle defense.

### Wave 5 — Standalone integration tests

Run Tasks 11, 12, and 13 concurrently after the entry point exists. All tests remain in this repository.

#### Task 11: Test controller failure and renderer selection

**Files:**

- `test/helpers.ts`
- `test/controller.test.ts`

**Instructions:** Build a small fake ExtensionAPI/context/event harness. Test `auto`, explicit context-full, explicit snapcompact, custom instructions, text-only model, missing model/key, abort, boundary failure, artifact failure, model failure with deterministic fallback, and status updates.

**Acceptance:** Successful paths return complete custom compaction. Every accepted failure returns cancel. No test accepts undefined.

#### Task 12: Prove built-in remote compaction interception

**Files:**

- `test/remote-interception.test.ts`

**Instructions:** Test against the OMP dev dependency without modifying it. Prefer an AgentSession integration harness like OMP’s own compaction-hook tests. Configure remote-enabled context-full and inject a deterministic plugin summarizer. Supply a throwing/counting remote endpoint or provider-native request seam. Cover manual configured remote, explicit one-off remote mode if public test APIs allow it, and automatic remote-enabled context-full.

Also cover summary failure reaching deterministic fallback and artifact/abort cancellation.

**Acceptance:** Successful cases install `fromExtension` LCM results and the built-in remote request counter remains zero. Cancelled cases also leave the built-in remote counter at zero. If a provider-native seam cannot be injected through public APIs, retain the strongest executable endpoint test and add a direct control-flow assertion proving the complete hook result is returned; do not modify OMP to create a seam and do not falsely claim an unexecuted provider-native test.

#### Task 13: Test persistence, repeated compaction, and resume

**Files:**

- `test/lifecycle.test.ts`

**Instructions:** Use a temporary persistent session and public OMP APIs. Run at least two generations for each renderer, rebuild context, and reopen the session.

**Acceptance:** Exact raw JSONL is readable; all raw sources are transitively reachable; roots remain bounded; artifact IDs continue after resume; context-full exposes textual root references; snapcompact exposes a valid reattached summary-only archive; unique raw sentinels never appear in snapcompact source.

### Wave 6 — Documentation and packaging cleanup

Do this only after runtime behavior and focused tests pass.

#### Task 14: Write standalone user documentation

**Files:**

- `README.md`
- top-level comments in `src/index.ts`

**Instructions:** Document installation from the repository/package, OMP plugin enablement, supported OMP versions, renderer setting, `/lcm` commands, context-full and snapcompact examples, remote interception semantics, artifact retrieval, session-scoped IDs, hosted summarizer calls, fail-closed behavior, and limitations for handoff/shake/off and unavailable async transactions.

Do not tell users to copy files into OMP source or patch OMP.

**Acceptance:** A user can install and activate the plugin, select a renderer, trigger compaction, inspect status, expand a node, and read exact source without opening implementation code.

#### Task 15: Verify package contents

**Files:**

- package metadata only if correction is required

**Instructions:** Run `bun pm pack`, inspect the tarball file list, then remove the generated tarball after verification unless the repository convention explicitly tracks release tarballs.

**Acceptance:** Package contains `src`, `README.md`, `LICENSE`, and correct metadata. It excludes tests, PLAN.md unless intentionally packaged, local sessions, credentials, node_modules, coverage, and OMP source.

---

## Supervisor validation procedure

### After each wave

1. Read each changed local module and focused test.
2. Check it against the fixed contracts before running it.
3. Run only that wave’s focused tests.
4. Resolve failures at the source.
5. Run `bun run typecheck` after Waves 2, 4, and 5.
6. Do not run full validation until all focused tests pass.

Suggested commands from this repository root:

```bash
bun install
bun test test/contracts.test.ts
bun test test/source.test.ts
bun test test/summarize.test.ts
bun test test/dag.test.ts
bun test test/render-context-full.test.ts
bun test test/render-snapcompact.test.ts
bun test test/controller.test.ts
bun test test/tools.test.ts
bun test test/remote-interception.test.ts
bun test test/lifecycle.test.ts
bun run typecheck
```

The exact test runner options may be adjusted for the installed Bun version, but test semantics may not be weakened.

---

## Luna Medium verifier assignments

After implementation and focused tests pass, run these fresh read-only verifiers concurrently.

### Verifier A: standalone boundary

Inspect repository paths, imports, package metadata, and packed file list. Confirm all implementation and tests live in this repository, no file was added to an OMP checkout, no local relative OMP import exists, and installation uses package dependencies.

### Verifier B: exact retention and reachability

Inspect `src/source.ts`, `src/dag.ts`, and lifecycle fixtures. Starting at current roots, traverse every node and raw source. Confirm every entry discarded before each keep boundary exists exactly in raw JSONL and remains reachable after repeated compaction. Report exact missing entry IDs or broken artifact IDs.

### Verifier C: context-full and remote fail-closed path

Inspect `src/controller.ts`, `src/render-context-full.ts`, and remote tests. Confirm every accepted success returns a complete result and every accepted failure returns cancel. Confirm no undefined fallthrough exists. Confirm old remote preserve payloads are not merged. Report the actual executable evidence that built-in remote request count stayed zero.

### Verifier D: snapcompact source purity

Inspect `src/render-snapcompact.ts` and tests. Confirm the synthetic message contains only formatted LCM roots, previous snapcompact/provider-native preserve data is not passed, current LCM state survives, a second pass does not unfold the first archive, and context rebuild recognizes the result archive.

### Verifier E: convergence and bounded growth

Inspect `src/summarize.ts`, `src/dag.ts`, and tests. Confirm non-shrinking normal output escalates, non-shrinking aggressive output reaches deterministic fallback, fallback is bounded, roots never exceed four, and preserve data grows with current roots rather than total history.

### Verifier F: abort and partial-write safety

Trace every awaited artifact write and model request. Confirm abort checks surround them, a failed write is never referenced by an installed node, partial artifacts may be orphaned but partial state is never installed, and abort cannot fall through to built-in compaction.

### Verifier G: user retrieval smoke test

Install the plugin from this repository into a temporary OMP environment. Trigger deterministic context-full compaction, use `lcm_expand`, then `read` and `grep` the raw artifact. Repeat snapcompact archive reconstruction with a vision-capable test model or deterministic snapcompact fixture. Record actual artifact IDs and source sentinels.

The supervisor must fix every concrete verifier defect, rerun its focused test, and rerun that verifier scenario.

---

## Final validation

Run from this standalone repository:

```bash
bun test
bun run typecheck
bun run check
bun pm pack
```

Then perform two user-path smoke tests using the installed plugin:

### Context-full smoke

1. Enable the plugin.
2. Set renderer to context-full.
3. Use remote-enabled OMP context-full settings.
4. Trigger compaction.
5. Observe `/lcm status` reporting remote interception.
6. Expand the root node.
7. Read and grep an exact raw source artifact.
8. Confirm no built-in remote compaction request was observed by the test seam/log.

### Snapcompact smoke

1. Use a vision-capable model or controlled test fixture.
2. Set renderer to snapcompact.
3. Trigger two compactions with unique raw sentinels.
4. Rebuild/resume context.
5. Confirm snapcompact archive source contains root summaries and artifact links.
6. Confirm it does not contain either raw sentinel.
7. Expand current roots to recover both raw sentinels transitively.

Inspect the packed tarball. Remove temporary sessions, artifacts, credentials, coverage, and tarballs before finalizing unless explicitly intended as release assets.

---

## Completion checklist

- [ ] Repository is a standalone OMP plugin package.
- [ ] All implementation files are under this repository’s `src/`.
- [ ] All tests are under this repository’s `test/`.
- [ ] No OMP source checkout was modified.
- [ ] No local relative OMP source dependency exists.
- [ ] `package.json` exports `src/index.ts` and declares `omp.extensions`.
- [ ] Marketplace metadata points to `nszceta/omp-lcm-inspired-compaction`.
- [ ] Plugin settings support `auto`, `context-full`, and `snapcompact` renderers.
- [ ] First activation archives exact history covered by earlier non-LCM compactions.
- [ ] Repeated compaction captures only newly discarded source after the latest LCM generation.
- [ ] Recent entries at and after `firstKeptEntryId` are not archived prematurely.
- [ ] Exact source is stored as JSONL artifacts.
- [ ] Every active summary reference is appended by deterministic code.
- [ ] Every raw source remains transitively reachable from a current root.
- [ ] Active roots never exceed four.
- [ ] Preserve data contains bounded roots, not the full DAG.
- [ ] Normal, aggressive, and deterministic levels guarantee convergence.
- [ ] Context-full result strips old snapcompact and remote preserve payloads.
- [ ] Snapcompact receives only synthetic LCM root messages.
- [ ] Snapcompact never unfolds a previous raw archive.
- [ ] Snapcompact archive survives context rebuild.
- [ ] Complete hook results bypass built-in remote endpoint compaction.
- [ ] Complete hook results bypass provider-native remote compaction by control flow.
- [ ] Model-summary failure uses deterministic fallback without built-in compaction fallthrough.
- [ ] Abort, boundary failure, and artifact failure cancel without fallthrough.
- [ ] Artifact IDs continue safely after session resume.
- [ ] `lcm_expand`, `read artifact://ID`, selectors, and grep recover retained history.
- [ ] `bun test`, `bun run typecheck`, and `bun run check` pass.
- [ ] Packed package contains only intended standalone plugin files.
- [ ] README never instructs users to modify OMP source.

---

## Decisions subagents must not reopen

- The implementation lives entirely in this repository.
- OMP is a package dependency and read-only reference, not an implementation target.
- No core hook metadata change is allowed.
- No new OMP strategy is added.
- Existing `session_before_compact` custom results are the interception mechanism.
- The plugin fails closed after accepting an event.
- Context-full and snapcompact are the supported renderers.
- `auto` renderer uses preparation settings, model image capability, and public custom instructions.
- Artifacts are the immutable source store.
- Preserve data contains only bounded roots.
- Artifact IDs are numeric and session-scoped.
- IDs are appended after model output.
- Snapcompact receives synthetic roots and no previous snapcompact/provider-native archive.
- The active root maximum and snapcompact frame maximum are both four.
- The active model performs summaries; the plugin does not silently switch providers.
- Handoff, shake, off, async atomic swaps, and multi-write transactions are outside this standalone version.
