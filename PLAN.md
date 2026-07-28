# Implementation Plan: Artifact-Backed LCM Compaction Plugin for oh-my-pi

## Instructions to the supervisory model

You are the implementation supervisor. Execute this plan in `../oh-my-pi/`. Do not reinterpret or reduce the scope. The requested deliverable is a loadable oh-my-pi extension that implements the practical LCM invariants described below for both effective `context-full` and `snapcompact` compaction, including fail-closed interception of built-in remote/provider-native context-full compaction.

Use Luna Medium workers and Luna Medium verifiers. Keep every delegated task narrow and mechanical:

- Give each worker the exact files and symbols listed in its task.
- Give each worker the shared contracts in this document; do not ask a worker to invent an architecture.
- A worker should normally own one module and its focused unit test, or one small core API change and its focused test.
- Do not ask workers to run formatters, typechecking, or the full test suite. The supervisor runs validation after integrating each wave.
- Do not ask one worker to “implement the whole plugin,” “research the architecture,” or modify more than three production files.
- Run independent tasks in the same wave concurrently. Never run more than eight workers at once.
- After implementation, use separate read-only Luna Medium verifiers. Give each verifier one invariant or one execution path, not the entire change.
- Treat a verifier’s claim as untrusted until the supervisor reproduces it with the specified focused command.
- Preserve unrelated user changes. Do not reset or rewrite unrelated files.

The implementation is incomplete unless every acceptance criterion and verification scenario in this document passes.

---

## Goal

Create a loadable extension at:

```text
packages/coding-agent/examples/extensions/lcm-compaction/
```

The extension must replace ordinary `context-full` and `snapcompact` compaction with an artifact-backed hierarchical summary system:

1. Exact discarded `SessionEntry` data remains recoverable in session artifacts.
2. Active history contains concise summaries with deterministic `artifact://ID` references.
3. Repeated compactions form a bounded hierarchy of summary-node artifacts rather than repeatedly summarizing or rasterizing the complete raw transcript.
4. Context-full mode installs the bounded textual LCM root summary.
5. Snapcompact mode runs public `@oh-my-pi/snapcompact.compact()` over synthetic LCM root-summary messages, so snapcompact retains summaries and artifact references instead of raw transcript text.
6. A complete custom result returned from `session_before_compact` must short-circuit built-in local, remote-endpoint, OpenAI V1 provider-native, and OpenAI V2 streaming compaction.
7. Once the extension accepts a compaction event, it must fail closed. It must never return `undefined` and silently fall through to built-in remote compaction.
8. Retrieval must work with existing `read artifact://ID` and `grep ... artifact://ID`. Add a small recursive expansion tool so a model can traverse summary-node children without guessing the storage schema.

This is a practical plugin-level implementation of LCM. It must implement lossless source retention, deterministic references, hierarchical summaries, bounded active roots, retrieval, and guaranteed summarization convergence. Exact paper parity for asynchronous soft-limit compaction and transactional multi-write DAG commits is outside this plugin’s available API and is explicitly not part of this change.

---

## Architectural context the implementers must understand

### LCM paper invariants

`LCM_Paper_3.tex` is outside the oh-my-pi repository in `../tmp/LCM_Paper_3.tex` relative to the repository. Relevant sections are approximately lines 82–178.

The implementation must preserve these practical invariants:

- The immutable store is the source of truth. Summaries are derived views.
- Active context contains recent raw messages plus summary nodes for older history.
- Summary nodes form a hierarchy and retain provenance to children or raw sources.
- Identifiers are inserted by engine code after model summarization; never trust the model to reproduce identifiers.
- Every compacted message remains transitively reachable.
- If an LLM summary does not shrink its input, escalate from normal to aggressive summarization and finally to a deterministic bounded fallback.
- Large references must survive later hierarchy levels.

### Existing oh-my-pi compaction interception

`SessionBeforeCompactEvent` is defined in:

```text
packages/coding-agent/src/extensibility/shared-events.ts
```

It supplies:

- `preparation: CompactionPreparation`
- `branchEntries: SessionEntry[]`
- optional `customInstructions`
- `signal: AbortSignal`

`CompactionPreparation` is defined in:

```text
packages/agent/src/compaction/compaction.ts
```

It contains:

- `firstKeptEntryId`
- `messagesToSummarize`
- `turnPrefixMessages`
- `recentMessages`
- `isSplitTurn`
- `tokensBefore`
- `previousSummary`
- `previousPreserveData`
- `fileOps`
- effective `settings`, including `strategy` and `remoteEnabled`

A handler may return a complete `CompactionResult` through `SessionBeforeCompactResult.compaction`. Manual compaction honors this in `packages/coding-agent/src/session/session-maintenance.ts` around the current `session_before_compact` emission and the `compactionPrep.kind === "fromHook"` branch. Automatic compaction has the equivalent emission and branch later in the same file.

Important control-flow invariant:

```text
custom result returned
  -> compactionPrep.kind === "fromHook"
  -> plugin result is installed
  -> built-in snapcompact is skipped
  -> built-in context-full compact() is skipped
  -> remote endpoint and provider-native remote compaction are skipped
```

If the handler returns `undefined`, built-in processing resumes. Therefore `undefined` is forbidden after this plugin decides to handle an event.

### Remote context-full behavior that must be intercepted

Built-in context-full remote routing lives in:

```text
packages/agent/src/compaction/compaction.ts
```

Current paths include:

- configured `remoteEndpoint`
- OpenAI V2 streaming compaction when `remoteEnabled !== false`
- OpenAI V1 provider-native compaction when `remoteEnabled !== false`
- local summarization fallback

The plugin does not need to patch or intercept HTTP. Returning a complete result before core calls `compact()` is the correct interception point. Tests must prove the built-in remote request functions are never reached.

The plugin’s own ordinary LLM summary request is not “built-in remote compaction.” It may use the active model through `complete()`, following the existing `examples/hooks/custom-compaction.ts` pattern. Do not select a different provider by default. Use the current model and current model’s API key.

### Artifact behavior

`ExtensionContext.sessionManager` exposes `saveArtifact`, `getArtifactPath`, and `getArtifactManager`. Artifacts:

- have numeric session-scoped IDs;
- resume from the next unused ID;
- are shared by a parent and its subagent tree;
- resolve as `artifact://ID` within the calling session;
- support `read` selectors and path-only grep/search.

Relevant sources:

```text
packages/coding-agent/src/session/session-manager.ts
packages/coding-agent/src/session/artifacts.ts
packages/coding-agent/src/internal-urls/artifact-protocol.ts
```

Never invent artifact IDs. Obtain every ID from `saveArtifact()` and append references only after the save succeeds.

### Snapcompact behavior

The public package exports `compact`, `getPreservedArchive`, and archive helpers:

```text
packages/snapcompact/src/index.ts
packages/snapcompact/src/snapcompact.ts
```

Snapcompact normally unfolds its previous archive source and rerenders it with newly discarded raw history. The plugin must prevent this. For each LCM snapcompact pass:

- build synthetic messages containing only bounded LCM root summaries and root artifact references;
- pass previous preserve data containing only the LCM state, not the prior snapcompact archive or provider-native remote history;
- call public `snapcompact.compact()`;
- return its result with the LCM state retained in `preserveData`.

Snapcompact spreads unrelated previous preserve keys into its result. Supplying only the LCM key ensures a fresh summary-only archive and removes old raw snapcompact/remote payloads.

OMP reattaches a valid snapcompact archive on every context rebuild in:

```text
packages/coding-agent/src/session/session-context.ts
```

### Strategies in and out of scope

Supported effective actions:

- `context-full`
- `snapcompact`

Not supported by this plugin version:

- successful `handoff`, because it runs before `session_before_compact`;
- successful `shake`, because it performs its own artifact-backed rewrite and returns before the ordinary compaction hook;
- `off`, because it produces no compaction event.

Document that users must configure `context-full` or `snapcompact` for automatic LCM maintenance. Shake fallback and failed handoff may eventually enter context-full, but this is fallback behavior, not primary support.

---

## Fixed data contracts

All workers must use these contracts. A worker may add comments or narrow helper types but must not redesign them.

### Preserve-data key

```ts
export const LCM_PRESERVE_KEY = "ompLcmArtifactsV1";
```

Do not use the snapcompact preserve key and do not reuse provider-native compaction keys.

### Bounded persisted state

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

Only active roots belong in `preserveData`. Do not store the entire DAG or an ever-growing list of archived entry IDs in session JSONL. Child provenance lives inside immutable node artifacts.

Validate all unknown previous preserve data. An invalid or unknown version is treated as absent and must not crash compaction.

### Raw artifact

Tool type: `lcm-raw`

Content: UTF-8 JSONL. Each line is `JSON.stringify(sessionEntry)` for one exact source `SessionEntry`. Do not normalize, summarize, omit tool results, or rewrite fields before persistence.

A raw artifact may contain multiple entries, but chunk it so one summary request remains bounded. Raw artifacts themselves may be read with selectors if large.

### Summary-node artifact

Tool type: `lcm-node`

Content is formatted JSON:

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

Rules:

- `children`, `rawSources`, and all exposed IDs are numeric artifact IDs without the URI prefix.
- A leaf has one or more `rawSources` and no children.
- A condensed node has children and normally no direct raw sources.
- A legacy node may preserve `previousSummary` while its corresponding raw entries are archived during first activation.
- `summary` is model prose only. Retrieval lines are formatted by deterministic code outside the model.
- `createdAt` is informational; tests must not compare its exact value.

### Model-visible root format

Use one deterministic formatter everywhere:

```text
## Retained LCM history

### Root 1
<summary prose>
Expand node: artifact://<root artifact id>

### Root 2
...

Retrieval: use `read artifact://ID`; recursively inspect `children` and `rawSources`. Use `grep` against an artifact URI when searching exact retained text.
```

The formatter appends every `Expand node:` line after model output. The model must never be asked to reproduce artifact IDs.

### Bounds

Use exported constants so tests can override them:

```ts
MAX_ACTIVE_ROOTS = 4
RAW_CHUNK_TARGET_TOKENS = 12_000
ROOT_SUMMARY_TARGET_TOKENS = 2_048
SNAPCOMPACT_MAX_FRAMES = 4
```

If the current model context window is small, lower the raw chunk target to at most one eighth of the context window, with a floor of 2,048 tokens. Do not increase it above 12,000.

### Convergence

Every summary operation follows exactly three levels:

1. Normal: detailed structured summary with a target token budget.
2. Aggressive: terse bullet summary with half the normal target.
3. Deterministic fallback: no LLM call; return a bounded statement that the content is archived and can be expanded through the node/raw artifact. It may retain a bounded head/tail excerpt, but mandatory retrieval references take priority.

Measure the candidate after deterministic retrieval text is included. Accept it only if it is smaller than the input and within target. Level 3 must always terminate within target. If mandatory metadata alone exceeds target, place the full list inside the node artifact and keep only the single parent artifact reference in model-visible text.

---

## Source selection algorithm

Implement this exactly so first activation and repeated compaction are both recoverable.

1. Find the index of `preparation.firstKeptEntryId` in `branchEntries`. Abort the plugin compaction if it is missing.
2. Parse `preparation.previousPreserveData[LCM_PRESERVE_KEY]`.
3. If valid LCM state exists, find the latest compaction entry before the keep boundary whose preserve data contains that same LCM generation. Start new exact-source capture immediately after that compaction entry.
4. If no valid LCM state exists, start at the beginning of the branch. This first activation intentionally archives source entries covered by earlier non-LCM summaries, because the session branch still contains the raw entries.
5. End immediately before the keep boundary. This includes both ordinary discarded messages and a discarded split-turn prefix.
6. Keep exact entries in the raw artifact, including tool results and relevant custom/branch-summary entries. Administrative entries that cannot affect conversational history may be omitted only if a focused unit test names and justifies each omitted type. The safe default is to preserve the complete slice except prior compaction entries.
7. Use `preparation.messagesToSummarize` plus `turnPrefixMessages` as the model-summary source for newly discarded conversational content. On first activation, include `preparation.previousSummary` as a legacy summary input so older already-compacted history has a useful map while its exact branch entries are archived.
8. Do not include `recentMessages` in raw artifacts or summaries. They remain active after `firstKeptEntryId`.

If source capture is empty while preparation has messages to summarize, fail closed; this indicates a boundary bug.

---

## Plugin request and failure policy

### Enablement

Loading this dedicated extension enables it. Do not require a second hidden setting. Register:

- `--lcm-renderer` string flag with default `auto`; valid values are `auto`, `context-full`, `snapcompact`.
- `/lcm-status` command that reports generation, root count, renderer, and whether the last compaction intercepted a remotely enabled context-full request.

Renderer selection:

- `context-full`: always emit textual LCM roots.
- `snapcompact`: always render synthetic roots through snapcompact; reject use with a non-vision active model before artifact writes.
- `auto`: use the effective compaction action supplied by the core hook metadata added in Task 1.

### Fail closed

Once the extension handles an event:

- success returns `{ compaction: result }`;
- user abort returns `{ cancel: true }`;
- invalid boundary, artifact failure, invalid renderer/model combination, or unrecoverable implementation error returns `{ cancel: true }` after a concise UI error notice;
- it never returns `undefined`;
- LLM summary failure is not unrecoverable: continue to the aggressive attempt and then deterministic fallback;
- do not merge previous provider-native or snapcompact preserve payloads into the custom result.

This policy prevents accidental fallthrough to built-in remote compaction. Automatic cancellation may leave the context near its limit, but silently invoking a prohibited remote compaction is worse and violates the requested invariant.

### Abort handling

Pass `event.signal` to every LLM call and check it:

- before every artifact write;
- after every awaited write;
- before and after every summary request;
- before returning the compaction result.

An abort does not trigger deterministic fallback; it cancels.

---

## Minimal core hook metadata change

The plugin must know the effective action after manual overrides and automatic fallbacks. Add these fields to `SessionBeforeCompactEvent`:

```ts
trigger: "manual" | "automatic";
action: "context-full" | "snapcompact";
remoteEnabled: boolean;
```

Rules:

- Manual `action` is the action core would execute without a custom result, after `/compact` mode overrides, directed-summary rules, and model capability checks.
- Automatic `action` is the existing local `action` value after successful handoff has been excluded and after non-vision snapcompact has fallen back to context-full.
- `remoteEnabled` is the effective settings value for that invocation. It is informational when action is snapcompact.
- Do not add handoff or shake to this hook’s `action`; successful handoff and shake do not emit this event.
- Update both hook and extension event typings because they share `shared-events.ts`.
- Add focused tests proving the fields for manual context-full, manual remote, manual snapcompact, automatic context-full, and automatic snapcompact/non-vision fallback.

Do not add a new compaction strategy enum. The extension intercepts existing actions.

---

## Implementation waves and Luna-sized tasks

The supervisor must initialize a todo list containing every task below. Tasks in the same wave may run concurrently only when their listed dependencies are complete.

### Wave 1: core event contract

#### Task 1 — Add effective compaction metadata

**Files:**

- `packages/coding-agent/src/extensibility/shared-events.ts`
- `packages/coding-agent/src/session/session-maintenance.ts`
- one focused existing compaction lifecycle/hook test file

**Change:** Add `trigger`, `action`, and `remoteEnabled` to `SessionBeforeCompactEvent`; populate them at both manual and automatic emit sites. Refactor only enough to compute manual intended action before emission. Preserve current behavior when no handler exists.

**Acceptance:** Typechecking succeeds; focused tests observe correct metadata; no strategy routing behavior changes.

### Wave 2: independent plugin foundations

Run Tasks 2, 3, and 4 concurrently after Task 1.

#### Task 2 — Define schemas and deterministic formatting

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/types.ts`
- `packages/coding-agent/test/lcm-compaction-types.test.ts`

**Change:** Implement the fixed data contracts, safe unknown-state parser, root formatter, artifact URI formatter, constants, and renderer flag parser. The parser rejects malformed versions and nonnumeric artifact IDs without throwing.

**Acceptance:** Unit tests cover valid state, invalid state, deterministic root order, and programmatic artifact lines.

#### Task 3 — Capture and chunk exact source entries

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/source.ts`
- `packages/coding-agent/test/lcm-compaction-source.test.ts`

**Change:** Implement the source selection algorithm, JSONL serialization, and token-bounded chunk planning. Make artifact saving a dependency passed into the function so tests use an in-memory fake. Do not summarize in this module.

**Acceptance:** Tests cover first activation, repeated LCM compaction, split-turn prefix, exclusion of recent entries, exact JSONL round-trip, missing boundary failure, and stable chunk order.

#### Task 4 — Implement three-level summarization

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/summarizer.ts`
- `packages/coding-agent/test/lcm-compaction-summarizer.test.ts`

**Change:** Implement normal, aggressive, and deterministic convergence. Inject the model-call function and token counter. Return prose separately from deterministic provenance/retrieval formatting.

**Acceptance:** Tests prove normal success, aggressive escalation after non-shrinking output, deterministic fallback after two failures or oversized outputs, target bound, reference retention, and abort propagation.

### Wave 3: DAG and renderers

Run Tasks 5, 6, and 7 concurrently after Wave 2 contracts pass.

#### Task 5 — Build and condense the artifact DAG

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/dag.ts`
- `packages/coding-agent/test/lcm-compaction-dag.test.ts`

**Change:** Combine previous roots with new leaf nodes, save immutable node artifacts, and condense oldest roots until at most `MAX_ACTIVE_ROOTS` remain and formatted roots fit the target. Parent nodes contain child artifact IDs. Active state contains only bounded root descriptors.

**Acceptance:** Tests prove every raw artifact is reachable from a root, root count remains bounded across at least ten simulated generations, child order is stable, preserve state does not grow with total node count, and parent visible text contains a single deterministic parent reference.

#### Task 6 — Implement context-full renderer

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/render-context-full.ts`
- `packages/coding-agent/test/lcm-compaction-context-full.test.ts`

**Change:** Convert bounded roots into a `CompactionResult`. Preserve `firstKeptEntryId` and `tokensBefore`. Return only `LCM_PRESERVE_KEY` state. Never carry prior snapcompact, OpenAI remote, or V2 preserve payloads.

**Acceptance:** Tests seed all three kinds of old preserve payload and prove the result contains only valid LCM state; summary contains root artifact references; recent-message boundary values are unchanged.

#### Task 7 — Implement snapcompact renderer

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/render-snapcompact.ts`
- `packages/coding-agent/test/lcm-compaction-snapcompact.test.ts`

**Change:** Build a synthetic snapcompact preparation containing only formatted LCM roots. Pass previous preserve data containing only `LCM_PRESERVE_KEY`. Use public `@oh-my-pi/snapcompact.compact()` with `SNAPCOMPACT_MAX_FRAMES`. Return its archive plus LCM state.

**Acceptance:** `archiveSourceText(getPreservedArchive(result.preserveData))` contains summary markers and `artifact://` references, does not contain a unique raw-history sentinel, and does not contain old snapcompact or provider-native preserve content. A second render uses current roots rather than unfolding the previous archive.

### Wave 4: extension assembly and retrieval

Tasks 8 and 9 may run concurrently after Wave 3.

#### Task 8 — Assemble the extension handler

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/index.ts`
- `packages/coding-agent/test/lcm-compaction-extension.test.ts`

**Change:** Register flags, `/lcm-status`, and `session_before_compact`. Use current `ctx.model`, `ctx.modelRegistry.getApiKey`, `complete()`, the event signal, and the completed source/summarizer/DAG/render modules. Select renderer from the fixed policy. Implement fail-closed behavior and concise UI notices. Export a factory with injected summarizer dependencies for tests; default export wires real OMP APIs.

**Acceptance:** Tests cover successful context-full, successful snapcompact, no model/key, artifact failure, abort, invalid renderer, and status output. Every handled failure returns cancel rather than undefined.

#### Task 9 — Add recursive expansion tool

**Files:**

- `packages/coding-agent/examples/extensions/lcm-compaction/tools.ts`
- `packages/coding-agent/test/lcm-compaction-tools.test.ts`

**Change:** Register `lcm_expand` with numeric `artifactId` and bounded `depth` parameters. Resolve artifacts only through the calling session manager. Parse only `omp-lcm-node/v1`; display the node summary and recursively list child/raw `artifact://` references. Detect cycles defensively even though valid state is a DAG. Do not materialize raw artifacts unless explicitly requested by the tool parameter.

**Acceptance:** Tests cover leaf, condensed parent, depth limit, missing artifact, malformed node, and cycle defense. Tool output tells the model to use ordinary `read`/`grep` for exact raw content.

### Wave 5: end-to-end interception and persistence tests

Run Tasks 10 and 11 concurrently after the assembled extension exists.

#### Task 10 — Prove remote compaction interception

**Files:**

- `packages/coding-agent/test/lcm-compaction-remote-interception.test.ts`

**Change:** Use the existing AgentSession/extension test harness. Configure effective context-full remote compaction, including a provider-native eligible model or a remote endpoint stub. Inject a deterministic plugin summarizer so its own model call is not counted. Make the built-in remote request/fetch stub throw or increment a counter if called.

Test all of:

1. manual configured remote-enabled context-full;
2. explicit `/compact remote`/equivalent one-off mode;
3. automatic remote-enabled context-full;
4. plugin summarizer failure followed by deterministic fallback;
5. artifact failure or abort.

**Acceptance:** Cases 1–4 install an LCM compaction and built-in remote call count is zero. Case 5 cancels and built-in remote call count remains zero. `session_compact.fromExtension` is true on successful cases.

#### Task 11 — Prove repeated compaction, rebuild, and resume

**Files:**

- `packages/coding-agent/test/lcm-compaction-lifecycle.test.ts`

**Change:** Exercise a persistent session through at least two compactions in each renderer. Rebuild context and resume the session from disk.

**Acceptance:** Exact JSONL source can be read from every raw artifact; all raw sources remain transitively reachable from current roots; prior roots are condensed rather than dropped; active roots remain bounded; artifact IDs continue after resume; context-full rebuild exposes textual root references; snapcompact rebuild reattaches a summary-only archive; unique raw sentinels never appear in snapcompact archive source.

### Wave 6: documentation and cleanup only after behavior works

#### Task 12 — Document installation and constraints

**Files:**

- `packages/coding-agent/examples/extensions/README.md`
- comments at the top of `lcm-compaction/index.ts`

**Change:** Add concise installation and usage instructions, supported strategies, renderer flag, status command, retrieval examples, fail-closed remote behavior, session-scoped artifact IDs, and explicit non-support for handoff/shake/off. State that plugin LLM summarization may still call the active hosted model even though built-in remote compaction is bypassed.

**Acceptance:** A user can copy the extension directory to `~/.omp/agent/extensions/` or `.omp/extensions/`, select context-full or snapcompact, trigger compaction, inspect status, and retrieve a cited artifact without reading source code.

---

## Supervisor integration procedure

After each wave:

1. Read every changed module and its focused test. Check it against the fixed contracts; do not accept architectural substitutions.
2. Run only the focused tests for that wave.
3. Run coding-agent typechecking after Waves 1, 4, and 5.
4. Resolve failures at their source. Do not weaken assertions, skip tests, or add timing sleeps.
5. Do not run the full suite until all focused scenarios pass.

Suggested focused commands from repository root:

```bash
bun test packages/coding-agent/test/lcm-compaction-types.test.ts
bun test packages/coding-agent/test/lcm-compaction-source.test.ts
bun test packages/coding-agent/test/lcm-compaction-summarizer.test.ts
bun test packages/coding-agent/test/lcm-compaction-dag.test.ts
bun test packages/coding-agent/test/lcm-compaction-context-full.test.ts
bun test packages/coding-agent/test/lcm-compaction-snapcompact.test.ts
bun test packages/coding-agent/test/lcm-compaction-extension.test.ts
bun test packages/coding-agent/test/lcm-compaction-tools.test.ts
bun test packages/coding-agent/test/lcm-compaction-remote-interception.test.ts
bun test packages/coding-agent/test/lcm-compaction-lifecycle.test.ts
bun --cwd packages/coding-agent run check:types
```

If the repository’s Bun test wrapper requires a different invocation, use the nearest existing coding-agent test command without changing test semantics.

---

## Luna Medium verification assignments

Use fresh read-only verifier agents after all implementation tasks and focused tests pass. Run these verifiers concurrently. Each assignment is intentionally narrow.

### Verifier A — Source losslessness and provenance

Inspect `source.ts`, `dag.ts`, and their tests. Starting from every active root in the lifecycle fixture, traverse node children and raw sources. Confirm every entry before each `firstKeptEntryId` is present byte-for-byte after JSON parsing and remains reachable after the second compaction. Report missing entry IDs or unreachable artifacts exactly.

### Verifier B — Context-full and remote short circuit

Inspect the manual and automatic `fromHook` branches plus the extension handler and remote-interception test. Confirm every successful handled event returns a complete result before core `compact()` and every handled failure cancels. Confirm there is no `return undefined` path after acceptance. Confirm remote endpoint, OpenAI V1, and OpenAI V2 built-in paths cannot execute in the tested cases.

### Verifier C — Snapcompact archive purity

Inspect `render-snapcompact.ts` and lifecycle tests. Confirm synthetic input contains only LCM root summaries/references, previous snapcompact archive data is not supplied, old provider-native history is not preserved, and second compaction cannot unfold old raw archive source. Confirm OMP context rebuild receives a valid snapcompact archive.

### Verifier D — Guaranteed convergence and bounds

Inspect `summarizer.ts`, `dag.ts`, and tests. Confirm non-shrinking normal output escalates, non-shrinking aggressive output reaches deterministic fallback, fallback is bounded, active roots never exceed four, and preserve state size is bounded by active roots rather than historical node count.

### Verifier E — Abort and failure safety

Inspect all awaited calls in the handler. Confirm signal checks surround LLM calls and artifact writes. Confirm abort, missing model/key, boundary failure, and artifact failure cannot fall through to built-in compaction. Confirm partial artifact writes may be orphaned but are never referenced by an installed state.

### Verifier F — User-facing retrieval

Load the extension in a temporary persistent session, trigger one small context-full compaction with an injected deterministic summarizer, read the root node through `lcm_expand`, then read and grep its raw source artifact. Report the actual IDs and observed source sentinel. Repeat the context reconstruction check for snapcompact.

The supervisor must address every concrete verifier defect, rerun the affected focused test, and rerun that verifier’s scenario.

---

## Final validation

After all verifier defects are resolved:

1. Run all new LCM tests together.
2. Run existing focused regression tests for compaction hooks, manual snapcompact fallback, automatic snapcompact fallback/budget, artifact concurrency/resume, and internal artifact URLs.
3. Run coding-agent typechecking and Biome check once.
4. Smoke test the extension as a user in a temporary persistent session for both renderers.

Required regression commands should include the closest current equivalents of:

```bash
bun test \
  packages/coding-agent/test/lcm-compaction-*.test.ts \
  packages/coding-agent/test/agent-session-manual-snapcompact-fallback.test.ts \
  packages/coding-agent/test/agent-session-snapcompact-auto-fallback.test.ts \
  packages/coding-agent/test/agent-session-snapcompact-budget.test.ts \
  packages/coding-agent/test/artifacts-concurrency.test.ts \
  packages/coding-agent/test/internal-urls/artifact-path-only.test.ts
bun --cwd packages/coding-agent run check
```

Do not claim remote interception based only on code inspection. The throwing/counted remote stub must remain at zero in manual and automatic tests.

---

## End-to-end acceptance checklist

The implementation is done only when all boxes are true:

- [ ] Extension loads from the documented extension directory.
- [ ] Hook metadata exposes effective manual/automatic action and remote-enabled state.
- [ ] First activation archives exact earlier branch history, including history covered by a previous non-LCM summary.
- [ ] Repeated compaction archives only newly discarded history and preserves prior roots through the DAG.
- [ ] Every model-visible summary receives artifact references through deterministic code after model output.
- [ ] Every raw source remains transitively reachable from a current root.
- [ ] Active roots and preserve data remain bounded over repeated generations.
- [ ] Normal, aggressive, and deterministic summarization levels guarantee convergence.
- [ ] Context-full returns a portable textual root summary and strips old snapcompact/remote payloads.
- [ ] Snapcompact archives only synthetic root summaries/references and never unfolds a prior raw archive.
- [ ] Snapcompact archive is reattached after context rebuild.
- [ ] Built-in remote endpoint compaction is not called while LCM handles context-full.
- [ ] Built-in OpenAI V1 provider-native compaction is not called while LCM handles context-full.
- [ ] Built-in OpenAI V2 streaming compaction is not called while LCM handles context-full.
- [ ] LLM summary failure reaches deterministic fallback without remote-compaction fallthrough.
- [ ] Abort and artifact failure cancel without remote-compaction fallthrough.
- [ ] Artifact IDs continue safely after session resume.
- [ ] `lcm_expand`, ordinary `read artifact://ID`, selectors, and grep recover source material.
- [ ] Existing context-full, snapcompact, artifact, and compaction-hook regression tests still pass.
- [ ] Documentation accurately states supported strategies and plugin-level limitations.

---

## Decisions that must not be reopened by subagents

- This is an extension over existing `context-full` and `snapcompact`, not a newly registered strategy.
- Returning a complete `session_before_compact` result is the remote interception mechanism; do not patch HTTP clients.
- The plugin is fail-closed once it accepts an event.
- Artifacts are the immutable source store; `preserveData` contains only bounded active roots.
- Artifact IDs are numeric and session-scoped.
- References are appended programmatically, never generated by the LLM.
- Snapcompact receives synthetic summary messages and no previous snapcompact/provider-native archive.
- The active root limit is four and snapcompact frame limit is four for this version.
- The extension uses the current model; it does not silently select a cheaper or different provider.
- Handoff, shake, off, asynchronous soft-limit swaps, and transactional artifact/session commits are non-goals for this implementation.
