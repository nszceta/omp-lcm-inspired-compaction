# PLAN: Standalone Artifact-Backed LCM Compaction Plugin for Oh My Pi

> Updated 2026-08-01: PLAN_2.md (Deadline-Safe Tiered LCM Summarization) has been
> fully rolled into this document as **Part II — remaining work**. PLAN_2.md is
> deleted after the merge. Part I describes the implemented package and remains
> the contract the code follows; imperative wording in Part I describes the
> original task, which is completed unless a section says otherwise.
>
> Same date: **Part III** (paper-aligned extensions and explicit non-goals) was
> added after reviewing `LCM_Paper_3.tex` against the installed OMP 17.1.8
> packages. Part III is proposed work, not implemented; it is gated on Part II.
> Also rolled in: the full `GAPS.txt` register as the "Gap disposition"
> section, with one status/disposition per gap.

## Repository status (2026-08-01)

### Implemented and verified

- Standalone OMP plugin package at version `0.2.2`, all source under `src/`,
  all tests under `test/`, OMP package line `17.2.3` (compatible with the
  `17.1.8` line; the auth-retry APIs the plugin uses exist in both).
- Part I of this plan is fully built: source capture, three-level summary
  convergence, immutable DAG, context-full and summary-only snapcompact
  renderers, fail-closed controller, `lcm_expand` tool, `/lcm` commands,
  marketplace metadata, README, LICENSE.
- Provider-native replay is implemented on top of Part I (see the
  "Provider-native replay" section): lineage-gated OMP V1/V2 remote compaction
  orchestration, persisted reconstruction, and live canary evidence.
- **Part II (Deadline-Safe Tiered LCM Summarization) is implemented and
  verified.** The sequential per-chunk leaf-summary loop is gone; adjacent raw
  chunks are consolidated into model-aware summary batches, leaf summaries use
  the online TINY role by default, root condensation uses a stronger tier, all
  provider calls run through a bounded order-preserving pool inside an internal
  deadline with deterministic fallback, and status is populated before
  expensive work and finalized on every handled path. The 22-chunk regression
  completes in ~1.35 s against a 1.4 s injected budget (real wall clock,
  `test/controller-deadline.test.ts`). See Part II and "Implementation history
  — Part II and Part III".
- **Part III candidates A and B are implemented and verified:** `lcm_describe`
  (metadata lookup plus lazy type-aware exploration summaries) and `lcm_grep`
  (node-grouped, paginated, `summaryId`-scoped regex search of reachable raw
  history). `fileRefs` remains deferred per its gate. See Part III.
- **Part IV (reliability hardening) is implemented and verified.** Summary
  calls run through OMP's auth-retry resolver under `withAuth` (GAP-006
  closed), the tier availability gate shares that resolver and rejects the
  keyless sentinel, the v1 replay path forwards the session id (GAP-005
  closed), replay failures notify (GAP-016 closed), `/lcm status` survives
  reloads via a persisted diagnostics entry (GAP-027 closed), dependencies
  moved to OMP 17.2.3 (GAP-029 closed), and the tier-wrapper defect
  (GAP-032) is fixed. Live verification: 5/5 integration tests on a real
  openai-codex/gpt-5.3-codex-spark subscription with model-quality summaries
  and zero deterministic fallback. See Part IV.
- Current checks pass from the repository root (2026-08-01):
  `bun test` → 202 pass, 3 skip (live integration, gated on
  `LCM_LIVE_INTEGRATION=1`), 0 fail; `bun run typecheck` clean;
  changed files pass `bun run check` (the repo-wide biome check still
  reports pre-existing legacy `any` sites in files this work never touched).
  Evidence log: `VERIFICATION.md` (Parts IV and V).
- Tarballs from `bun pm pack` inspections exist untracked (`*.tgz` is
  gitignored) and are not release assets.

### Remaining work

1. **Open gaps** — each registered with a disposition in the "Gap
   disposition" section (rolled in from `GAPS.txt`): P1 GAP-008–015
   (GAP-013 closed 2026-08-01 by the concurrent-replay work),
   P2 GAP-017–026, P3 GAP-028–031. GAP-003/004/005/006/007/016/027/029/031/032
   are closed; GAP-026 is partially closed by the Part II runtime-status
   contract; GAP-021 is partially addressed by Part III Candidate B.
   `GAPS.txt` remains the detailed register; PLAN.md is authoritative for
   dispositions.
2. **Part V (implemented 2026-08-01): orphan-window hardening and automated
   release canary** — raw artifacts are now written only immediately before
   their leaf node (an abort before the first node write leaves zero
   artifacts), `lastOrphanArtifactCount` reports files not referenced by any
   installed node or root at run start (GAP-012 mitigation + GAP-023
   observability), and `bun run canary` runs pack → clean-profile install →
   live integration, failing the release on any step failure (GAP-030
   closed). See Part V.
3. **Deferred — `fileRefs` node field.** Optional additive field on
   `LcmNodeArtifactV1` recording spilled-artifact IDs; gated on `lcm_describe`
   showing real use. Old nodes are never rewritten; parsers already tolerate
   absent optional fields.
4. **Part III explicit non-goals** remain unimplemented by design (LLM-Map/
   Agentic-Map, scope-reduction guard, deferred compaction
   execution, embedding index, `lcm_expand` sub-agent restriction,
   capture-time file pipeline).
5. **Part VI (implemented 2026-08-01): concurrent provider-native replay** —
   the replay branch now starts right after raw capture and runs concurrently
   with leaf summarization and DAG condensation under the same absolute
   deadline and cancellation signal; failure is fail-isolated and the textual
   LCM result stays authoritative (GAP-013 closed). See the disposition.

---

# Part I — Implemented contract

## Supervisory instruction

This document is the single plan for the repository containing it:

```text
~/src/nszceta/omp-lcm-inspired-compaction/
```

All plugin code, package metadata, tests, fixtures, documentation, and
marketplace metadata live in this repository. Do not create or edit files in an
Oh My Pi source checkout. Do not place implementation files under
`packages/coding-agent`, `packages/agent`, `packages/snapcompact`, or any other
upstream directory.

Oh My Pi source may be read to verify public API behavior, but it is an
external dependency and must remain unchanged. The standalone package must
integrate through published/public OMP extension APIs and package dependencies.

For the remaining Part II work: use Luna Medium workers and Luna Medium
verifiers. Keep every delegated task small and mechanical:

- Give each worker the exact local files and fixed contracts from this document.
- A worker should own one small module and its unit test, or one narrow
  integration test.
- No worker may redesign the architecture or move implementation into OMP.
- No worker should modify more than three production files.
- Workers must skip formatters, project-wide typechecking, and the full test
  suite. The supervisor runs validation after integrating each phase.
- Run independent tasks in one concurrent wave. Never run more than eight
  workers at once.
- Use fresh read-only Luna Medium verifiers after implementation.
- Preserve unrelated repository changes.
- Do not weaken an assertion or skip a failing test to make validation pass.

The result is incomplete unless every acceptance criterion in this plan
(Parts I, II, and III) is satisfied.

---

## Testing integrity — no cheating (all parts)

Every test in this repository must produce legitimate evidence. A test that
cannot fail on a plausible bug, or that passes only because its inputs were
arranged to match the implementation, is not evidence and must be removed or
rewritten. These rules bind Part I regression work, Part II, and Part III.

1. **Assertions defend observable contracts.** Each assertion must fail on a
   plausible bug in the code under test. Assert behavior, boundaries,
   invariants, transitions, precedence, and real errors — not source text,
   incidental defaults, or internal data shapes that are not part of the
   contract.

2. **No golden answers copied from the implementation.** Expected values must
   be derived from the contract and fixtures by an independent oracle
   (hand-specified JSON, manually counted entries, fixed sentinels). Never
   paste the output of the code under test into an assertion to make it pass.
   Deterministic markers produced by plugin code (e.g. `artifact://` links,
   root counts, bounded sizes) are asserted directly; prose produced by a
   model is never asserted for equality.

3. **Fakes must be adversarial where failure matters.** Injected fakes (model
   calls, token counters, artifact savers, model registries) must be able to
   fail, return oversized or non-shrinking output, resolve out of order, and
   exceed deadlines — and tests must exercise those paths. A suite whose
   fakes are always friendly proves nothing about the failure handling this
   plan promises. Where a path is claimed to be covered (e.g. deterministic
   fallback, cancel-on-abort), at least one test must reach it through the
   real control flow, not by substituting its result.

4. **Real-runtime coverage is required, not optional.** Every claimed
   behavior needs at least one test against a real OMP surface (session
   artifact store, `session_before_compact`, extension registration, context
   reconstruction) in addition to unit tests with injected seams. A fake
   harness is a unit test and must be labeled as such; it is not an
   integration test. Part II requires at least one real wall-clock delay test
   for the deadline race; fake timers alone are not sufficient and must not
   be used to make a race disappear.

5. **No skipping or weakening to green.** A failing test is fixed at the
   source — never skipped, weakened, or stripped of assertions to make
   validation pass. Tests may be skipped only for environment-gated reasons
   (live credentials) and must then be reported as skipped by the runner;
   silently dropping a test is a validation violation.

6. **Live-provider tests must be contamination-proof.** Live integration and
   smoke tests must use freshly generated, unique sentinels (nonces,
   codenames, batch values) asserted after compaction and reconstruction, so
   a passing result cannot come from the provider's parametric memory of a
   fixed string. Never reuse fixed secrets or benchmark-like answers as the
   assertion target. Assert persisted structural state (item counts, lineage
   fields, artifact IDs) rather than generated prose. The 2026-07-28 canary
   in README follows this pattern.

7. **Fixture provenance is explicit.** Fixtures that feed capture assertions
   must round-trip through the real capture/chunking path. Hand-written raw
   artifacts are allowed only where the test targets parsing, rendering, or
   traversal, and must be labeled as such. Raw artifacts in lifecycle tests
   are produced by the real code, not fabricated to match assertions.

8. **Test names and files describe what they prove.** A test named for a
   behavior must exercise that behavior; integration-shaped tests must
   exercise OMP. Rename or rewrite misleading tests rather than leaving a gap
   between the claim and the assertion.

---

## Required repository outcome (current shape)

The finished repository is a normal standalone OMP plugin package. Current
shape (2026-08-01):

```text
omp-lcm-inspired-compaction/
├── .gitignore
├── .omp-plugin/
│   └── marketplace.json
├── LICENSE
├── PLAN.md
├── GAPS.txt
├── VERIFICATION.md
├── README.md
├── biome.json
├── package.json
├── tsconfig.json
├── bun.lock
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── contracts.ts
│   ├── source.ts
│   ├── summarize.ts
│   ├── dag.ts
│   ├── render-context-full.ts
│   ├── render-snapcompact.ts
│   ├── replay-lineage.ts
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
    ├── tools.test.ts
    ├── omp-profile.test.ts
    ├── native-replay.test.ts
    └── native-replay.integration.test.ts
```

Minor fixture files under `test/fixtures/` are allowed. Do not introduce a
monorepo, copy OMP source into this repository, use Git submodules, or require
consumers to patch OMP. Part II may add pure modules (e.g. batch planner,
bounded worker pool, deadline helpers) under `src/` with their own focused
tests.

The package entry point is `./src/index.ts`. `package.json` declares it through
both `exports` and `omp.extensions`, following established standalone OMP
plugin conventions.

## Product goal (implemented)

Implement a loadable OMP extension that replaces ordinary `context-full` and
`snapcompact` compaction with a practical Lossless Context Management system:

1. Preserve exact discarded OMP `SessionEntry` objects in session artifacts.
2. Generate concise summaries of bounded source chunks.
3. Insert `artifact://ID` references through deterministic code after
   summarization.
4. Store immutable leaf and parent summary nodes as artifacts.
5. Keep only a bounded set of root summaries in active context and compaction
   `preserveData`.
6. Keep every compacted source entry transitively reachable from a current
   root.
7. Render roots as plain text for context-full compaction.
8. Render roots through public `@oh-my-pi/snapcompact` for snapcompact
   compaction, ensuring snapcompact retains summaries and artifact IDs rather
   than raw historical transcript text.
9. Intercept built-in remote context-full compaction by returning a complete
   custom result from `session_before_compact` before OMP reaches its local,
   remote-endpoint, OpenAI V1, or OpenAI V2 compaction path.
10. Fail closed after accepting an event so errors cannot silently fall through
    to built-in remote compaction.
11. Provide a small `lcm_expand` tool for traversing node artifacts; ordinary
    OMP `read` and `grep` remain the source-retrieval tools.

Part II adds a twelfth, currently unmet goal: **every handled compaction must
return a custom LCM result before OMP's fixed 30-second extension-handler
timeout**, via consolidated summary batches, bounded parallel model calls,
online `TINY`/`SMOL` model tiers, an internal deadline with deterministic
fallback, and early status updates.

This plugin implements the practical LCM invariants available through the
current public OMP API. It does not claim exact parity with asynchronous or
transactional features unavailable to a standalone extension.

## Non-negotiable standalone boundary

### Allowed

- Import public APIs from published OMP packages.
- Depend on `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-agent-core`,
  `@oh-my-pi/pi-ai`, and `@oh-my-pi/snapcompact` as required.
- Read upstream source or installed package source to confirm signatures.
- Reference the Oh My Pi source checkout at `~/src/oh-my-pi/` (read-only) to
  verify public API behavior and extension-surface semantics. That checkout
  remains an external dependency and must stay unchanged; nothing here may
  import from it or copy its source into this repository.
- Use `session_before_compact`, `ExtensionContext.sessionManager`, plugin
  settings APIs, commands, flags, and `registerTool`.
- Build integration tests in this repository against the OMP package listed in
  `devDependencies`.

### Forbidden

- Editing an OMP checkout.
- Adding fields to `SessionBeforeCompactEvent` in OMP.
- Adding a new OMP compaction strategy enum.
- Adding tests to OMP's test directories.
- Monkey-patching OMP or snapcompact internals.
- Patching HTTP clients to stop remote compaction.
- Depending on unpublished local relative imports such as
  `../oh-my-pi/packages/...`.
- Requiring users to copy files manually into the OMP package.
- Increasing OMP's extension-handler timeout (Part II depends on finishing
  inside it, not on changing it).

The remote interception mechanism is the existing custom compaction result.
The plugin must not require any core change.

## OMP behavior this standalone plugin relies on

The following context is included so workers do not need to rediscover the
architecture.

### Compaction hook

OMP emits `session_before_compact` for ordinary manual and automatic
compaction. The event provides:

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

`preparation.settings` contains the effective invocation settings, including
`strategy` and `remoteEnabled`. Manual `/compact soft`, `/compact remote`, and
`/compact snapcompact` overrides are reflected in the preparation settings.

A handler may return:

```ts
{ cancel: true }
```

or:

```ts
{ compaction: CompactionResult }
```

A complete custom result causes OMP to install that result and skip its
built-in snapcompact and context-full `compact()` calls. Skipping context-full
`compact()` also skips:

- configured remote endpoint compaction;
- provider-native OpenAI V1 compaction;
- provider-native OpenAI V2 streaming compaction;
- built-in local summary fallback.

If the handler returns `undefined`, OMP resumes built-in compaction. Therefore
this plugin must never return `undefined` after deciding to handle the event.

### Strategy selection without core changes

The event does not expose a separate final `action` field. The plugin must
select its renderer using available public information:

1. Plugin setting `renderer=context-full`: always use text roots.
2. Plugin setting `renderer=snapcompact`: use snapcompact only if `ctx.model`
   accepts image input; otherwise cancel before writing artifacts.
3. Plugin setting `renderer=auto`:
   - use snapcompact when `preparation.settings.strategy === "snapcompact"`,
     the current model accepts image input, and `event.customInstructions` is
     absent;
   - otherwise use context-full.

This mirrors the relevant public behavior without changing OMP. An internal
OMP guidance value is not exposed to extensions. Document that
`renderer=auto` cannot observe hidden internal-guidance overrides; users
needing deterministic behavior should set the plugin renderer explicitly.

Successful `handoff` and `shake` execute outside or before the ordinary custom
compaction result path. They are not primary supported strategies. `off`
emits no compaction. Document that automatic LCM requires OMP strategy
`context-full` or `snapcompact`.

### Artifact API

`ExtensionContext.sessionManager` exposes public methods used by the plugin:

- `saveArtifact(content, toolType)`
- `getArtifactPath(id)`
- `getArtifactManager()`
- `getBranch()` and other read-only session methods

Artifact IDs are numeric strings, sequential within a session, resume-safe,
and shared by a parent/subagent tree. `artifact://ID` resolution is pinned to
the calling session. Existing OMP tools support selectors and path-only search
against artifacts.

Never predict an ID. Save first, receive the ID, validate it, then append the
reference.

### Snapcompact API

Use the public package, not internal source paths:

```ts
import {
  archiveSourceText,
  compact,
  getPreservedArchive,
} from "@oh-my-pi/snapcompact";
```

Snapcompact normally unfolds its previous archive source and combines it with
newly discarded history. The plugin must prevent raw-history replay by giving
snapcompact a synthetic preparation whose messages contain only current LCM
root summaries and references, and whose `previousPreserveData` contains only
the plugin's bounded LCM key.

OMP will reattach a valid returned snapcompact archive on later context
rebuilds.

### Plugin settings API

Use standalone plugin metadata in `package.json` and public helpers:

```ts
import {
  getPluginSettings,
  PluginManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
```

Follow the same package-level pattern as other standalone OMP plugins:
settings are declared under `package.json#omp.settings`, read using the plugin
name and `ctx.cwd`, and changed through `PluginManager` when
`/lcm renderer ...` is used. Part II adds `leafSummaryModel`,
`rootSummaryModel`, `summaryConcurrency`, `summaryBatchInputTokens`, and
`handlerDeadlineMs` to the same settings object.

## LCM invariants implemented by this plugin

The original LCM method distinguishes an immutable source store from active
summaries. This plugin maps those concepts as follows:

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
- Every discarded source entry remains transitively reachable from an active
  root.
- The model is never responsible for copying an artifact ID correctly.
- Repeated compaction creates parent nodes rather than flattening and losing
  old provenance.
- Active root count and preserve-data size remain bounded.
- Failure after accepting a hook event cannot invoke built-in remote
  compaction.

Unavailable exact-paper features, explicitly out of scope:

- deferred compaction execution;
- atomic background summary installation;
- transactional commit spanning several artifact writes and OMP's compaction
  entry;
- globally unique artifact IDs across sessions;
- automatic pre-handoff source injection;
- automatic shake-region summary callbacks.

Partial writes may leave orphan artifacts. The plugin must never install a
node that references an artifact write that failed.

## Package contract (implemented, 0.2.2)

`package.json` (current values; OMP packages pinned to `17.2.3`, compatible
with the `17.1.8` line):

```json
{
  "name": "omp-lcm-inspired-compaction",
  "version": "0.2.2",
  "description": "Artifact-backed hierarchical LCM-inspired compaction for Oh My Pi",
  "type": "module",
  "license": "MIT",
  "files": ["src", "README.md", "LICENSE"],
  "exports": "./src/index.ts",
  "scripts": {
    "test": "bun test",
    "test:omp-profile": "bun test test/omp-profile.test.ts",
    "test:integration": "LCM_LIVE_INTEGRATION=1 bun test test/native-replay.integration.test.ts",
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
      },
      "leafSummaryModel": {
        "type": "enum",
        "values": ["tiny", "smol", "active"],
        "default": "tiny",
        "description": "Model tier for leaf/source-batch summaries (online TINY role preferred; local title models are never used)"
      },
      "rootSummaryModel": {
        "type": "enum",
        "values": ["tiny", "smol", "active"],
        "default": "smol",
        "description": "Model tier for root condensation and repair"
      },
      "summaryConcurrency": {
        "type": "number",
        "default": 4,
        "description": "Maximum concurrent summary model calls (1-8)"
      },
      "summaryBatchInputTokens": {
        "type": "number",
        "default": 48000,
        "description": "Maximum estimated tokens per consolidated summary batch (12000-96000)"
      },
      "handlerDeadlineMs": {
        "type": "number",
        "default": 24000,
        "description": "Internal compaction deadline; kept below OMP's fixed 30s handler timeout (10000-27000)"
      }
    }
  }
}
```

Dependency roles:

- `@oh-my-pi/pi-coding-agent`: peer and dev dependency; extension types,
  plugin settings, session API.
- `@oh-my-pi/pi-agent-core`: runtime dependency; compaction types and the
  provider-native compaction orchestrator helpers.
- `@oh-my-pi/pi-ai`: runtime dependency for `complete()` and model/message
  types.
- `@oh-my-pi/snapcompact`: runtime dependency for summary-only snapcompact
  rendering.
- `@oh-my-pi/pi-catalog`: dev dependency used by tests.
- `typescript`, `@types/bun`, and `@biomejs/biome`: dev dependencies.

No dependency on a filesystem checkout. `bun pm pack` output was inspected;
the tarball contains the extension source and documentation and must not
contain tests, local artifacts, sessions, or copied OMP source. Generated
tarballs are removed after inspection (leftover `*.tgz` files are gitignored).

`.omp-plugin/marketplace.json` names `nszceta/omp-lcm-inspired-compaction` as
the GitHub source and repository; the marketplace installs under the
`nszceta-lcm` name (see README).

## Fixed plugin data contracts (implemented)

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

For models with small context windows, lower raw summary chunks to no more
than one eighth of `ctx.model.contextWindow`, with a minimum target of 2,048
and maximum of 12,000.

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

Only current roots are stored in `preserveData`. Never persist the whole DAG
or an ever-growing set of entry IDs there. Child provenance is stored inside
immutable artifacts.

Parse previous state defensively from unknown input. Invalid version, invalid
roots, nonnumeric IDs, or unreasonable values produce "no prior LCM state,"
not a crash.

### Raw artifact

Tool type: `lcm-raw`.

Content: UTF-8 JSONL, one exact `JSON.stringify(sessionEntry)` per line. Do
not rewrite roles, tool results, timestamps, IDs, or message content.

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

- IDs inside `children` and `rawSources` are numeric strings without
  `artifact://`.
- Leaf nodes point to raw artifacts and have no children.
- Condensed nodes point to child node artifacts.
- Legacy nodes map a pre-plugin `previousSummary` to raw artifacts captured on
  first activation.
- The model supplies only `summary` prose.
- Plugin code writes all ID arrays and model-visible retrieval lines.
- Tests ignore the exact `createdAt` value.

`rawSources` is an array; Part II leaf nodes may reference multiple raw
artifacts. The implemented `dag.ts` already accepts `NewLeaf.rawArtifactIds`
arrays.

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

Never place a raw list of many child IDs into active context. The root node
artifact contains that list; active text needs only the root ID.

## Exact source-selection algorithm (implemented)

Implemented in `src/source.ts`:

1. Locate `preparation.firstKeptEntryId` in `event.branchEntries`. If absent,
   return a typed boundary error.
2. Parse LCM state from
   `preparation.previousPreserveData?.[LCM_PRESERVE_KEY]`.
3. If valid prior LCM state exists, search backward before the keep boundary
   for the latest compaction entry whose preserve data contains the same LCM
   generation. Capture after that entry.
4. If no valid prior LCM state exists, capture from the beginning of the
   branch. This first run intentionally captures raw entries covered by
   earlier non-LCM compactions because OMP branch history still retains those
   entries.
5. End immediately before the keep boundary. This covers fully discarded
   messages and a discarded split-turn prefix.
6. Exclude prior compaction entries themselves from raw JSONL. Preserve
   conversational entries, tool results, custom messages, and branch
   summaries. Administrative entries may be omitted only when a focused unit
   test explicitly justifies the omission.
7. Never capture entries at or after `firstKeptEntryId`; those are recent
   active history.
8. Chunk the exact-entry slice in stable order by estimated serialized token
   count. Do not split one `SessionEntry` between raw artifacts.
9. Save every raw chunk before creating a node that references it.
10. Use `preparation.messagesToSummarize` plus `turnPrefixMessages` as the new
    LLM summary input. On first activation, also incorporate
    `preparation.previousSummary` as a legacy map for older already-compacted
    source.

If preparation contains discarded messages but source capture is empty,
cancel. This is a boundary error, not permission to fall back to built-in
compaction.

## Summary and convergence contract (implemented)

Implemented in `src/summarize.ts` with dependency injection for tests.

### Default model call

Current behavior (to be superseded by the Part II tier policy once
implemented):

```ts
const model = ctx.model;
const apiKey = await ctx.modelRegistry.getApiKey(model);
const response = await complete(model, request, {
  apiKey,
  maxTokens: target,
  signal: event.signal,
});
```

Follow the public API signature installed in this repository. The direct
summary request may use a hosted model. "Remote interception" in this plan
means disabling OMP's built-in remote/provider-native compaction path, not
eliminating all network traffic.

### Three levels

For every leaf or parent summary:

1. **Normal:** structured, detail-preserving summary targeting the requested
   token count.
2. **Aggressive:** terse bullet summary targeting half the normal count.
3. **Deterministic:** no LLM call; emit a bounded archival statement and
   optional bounded head/tail excerpt.

Measure the candidate after mandatory deterministic retrieval wording is
added. Accept an LLM candidate only when it is smaller than input and within
target. Two oversized, empty, errored, or non-shrinking attempts reach
deterministic fallback.

Abort is different from summary failure. If the signal is aborted, stop and
cancel; do not run further levels.

The deterministic level must always fit. If provenance would be long, store it
in the node and expose only one root/node artifact reference.

Prompts must request these categories without requesting IDs:

- goals and user intent;
- decisions and rationale;
- files, symbols, commands, and observed results;
- errors, blockers, and unresolved risks;
- current state and next actions;
- facts needed to continue accurately.

Artifact IDs are appended after the response by deterministic code.

## DAG construction contract (implemented)

Implemented in `src/dag.ts`.

### Leaf generation

For each bounded new source chunk:

1. Save exact JSONL as `lcm-raw` and receive its numeric ID.
2. Summarize the corresponding bounded conversational text.
3. Save an `omp-lcm-node/v1` leaf containing summary prose, raw source IDs,
   and exact source entry IDs.
4. Receive the node artifact ID.
5. Add a root descriptor only after both writes succeed.

Part II consolidates adjacent raw chunks into summary batches; one leaf may
then reference several raw artifact IDs, with all source entry IDs covered by
those artifacts. The implemented `NewLeaf` already carries
`rawArtifactIds: string[]`.

On first activation with a non-LCM `previousSummary`, create a legacy node
whose summary is the previous summary and whose raw sources cover the older
exact captured entries. Do not ask an LLM to recreate information already
represented by the previous summary.

### Condensation

Combine prior roots and new roots in chronological order. While there are more
than four roots or formatted roots exceed `ROOT_SUMMARY_TARGET_TOKENS`:

1. Take the oldest bounded group, at most four roots.
2. Summarize their prose without loading raw source.
3. Save a condensed node containing the child node artifact IDs.
4. Replace those roots with the new parent root.
5. Repeat until bounds hold.

The previous child nodes remain immutable and reachable. Preserve data
contains only final roots.

### Write safety

Artifact writes and OMP compaction installation are not transactional. Enforce
the safe direction:

- A failed raw write cannot produce a leaf.
- A failed leaf write cannot produce an active root.
- A failed parent write cannot replace its children.
- A later failure may orphan already-written artifacts, but the handler
  cancels and installs no partial state.

## Renderer contracts (implemented)

### Context-full renderer

Implemented in `src/render-context-full.ts`: returns a complete OMP
`CompactionResult`:

- `summary`: deterministic formatted roots;
- `shortSummary`: concise count of roots and archived source entries;
- `firstKeptEntryId`: copied exactly from preparation;
- `tokensBefore`: copied exactly from preparation;
- `details`: optional bounded LCM statistics;
- `preserveData`: exactly `{ [LCM_PRESERVE_KEY]: state }`.

Do not merge old snapcompact or provider-native remote preserve data. The
resulting textual root is portable across providers. (The controller may add
`openaiRemoteCompaction` and `ompLcmNativeReplayLineageV1` after rendering;
see "Provider-native replay".)

### Snapcompact renderer

Implemented in `src/render-snapcompact.ts`:

1. Reject a non-vision model before writes when snapcompact is explicitly
   required.
2. Format current LCM roots.
3. Construct one synthetic text message containing only those roots and
   retrieval instructions.
4. Construct a public snapcompact preparation using original
   `firstKeptEntryId`, `tokensBefore`, and file operations, empty prefix
   messages, and no raw transcript messages.
5. Set synthetic `previousPreserveData` to exactly
   `{ [LCM_PRESERVE_KEY]: state }`.
6. Call public snapcompact `compact()` with `maxFrames: 4` and the active
   model.
7. Return the snapcompact result. Its preserve data must contain the new
   snapcompact archive plus the same LCM state.

Never pass `preparation.previousPreserveData` directly. That could unfold an
old raw snapcompact archive or retain provider-native replacement history.

A second LCM snapcompact pass must reconstruct synthetic source from current
roots and again omit the previous archive. Snapcompact must never rerasterize
old raw transcript.

## Remote interception and fail-closed behavior (implemented)

Implemented in `src/controller.ts`.

### Event acceptance

The extension handles every `session_before_compact` event while loaded. It
does not return `undefined`.

- Success: return `{ compaction: result }`.
- User abort: return `{ cancel: true }`.
- Missing model or API key: notify and return `{ cancel: true }`.
- Boundary or state error: notify and return `{ cancel: true }`.
- Artifact write failure: notify and return `{ cancel: true }`.
- Explicit snapcompact with non-vision model: notify and return
  `{ cancel: true }`.
- Model summary failure: escalate and use deterministic fallback; do not
  cancel unless aborted.
- Unexpected exception: notify, log, and return `{ cancel: true }`.

This guarantees OMP cannot continue to built-in local or remote compaction
after the plugin accepts the event.

### Remote observability

Track bounded in-memory status for `/lcm status`. The implemented
`LcmRuntimeStatus` extends the fields below with root details, raw
artifact/source counts, summary preview, preserve keys, snapcompact frame
count, native replay fields, and summary quality (see `src/controller.ts`).
The interception flag is implemented as `builtInRemoteContextFullIntercepted`
(named for "built-in branch interception"; the original working name
`lastRemoteEnabledIntercepted` was renamed in code):

```ts
interface LcmRuntimeStatus {
  lastRenderer?: "context-full" | "snapcompact";
  lastGeneration?: number;
  lastRootCount?: number;
  lastRawArtifactCount?: number;
  builtInRemoteContextFullIntercepted?: boolean;
  lastOutcome?: "success" | "cancelled";
  lastSummaryQuality?: "model" | "deterministic-fallback";
  lastDeterministicFallbackCount?: number;
  lastNativeReplayStatus?: "preserved" | "disabled" | "ineligible" | "unavailable" | "empty" | "failed";
  lastNativeReplayProvider?: string;
  lastNativeReplayItemCount?: number;
  lastNativeReplaySeeded?: boolean;
  lastNativeReplayError?: string;
  lastError?: string;
}
```

Set `builtInRemoteContextFullIntercepted` when the handled preparation has
`settings.remoteEnabled !== false` and the selected renderer is context-full.
Do not persist API keys, prompts, raw source, or unbounded errors in status.
Part II extends this interface with deadline, batch, and tier fields.

### Settings and command

`src/config.ts` reads `renderer` from
`getPluginSettings(PLUGIN_NAME, ctx.cwd)` and validates unknown values.
`persistRenderer` adapts to the plugin-manager method surface (see GAP-028).

Registered commands (implemented in `src/index.ts`):

```text
/lcm help
/lcm version
/lcm status
/lcm dump
/lcm renderer auto
/lcm renderer context-full
/lcm renderer snapcompact
```

Persist renderer changes through `PluginManager`. If persistence fails, report
the error; do not pretend it was saved.

## Provider-native replay (implemented)

Beyond the original Part I scope, the plugin preserves provider-native remote
compaction continuity. Implemented in `src/replay-lineage.ts` and
`src/controller.ts`; documented in README; register `GAPS.txt` GAP-003,
GAP-004, and GAP-007 as closed.

- For eligible OpenAI Responses models with `settings.remoteEnabled !== false`,
  the controller delegates replay generation to OMP's published compaction
  orchestrator (`@oh-my-pi/pi-agent-core/compaction`), choosing streaming V2
  when the model advertises it and the setting permits it, else V1.
- The resulting `openaiRemoteCompaction` preserve data is merged beside
  `ompLcmArtifactsV1`; a plugin-owned `ompLcmNativeReplayLineageV1` records
  provider, effective model ID, mechanism (V1/V2), normalized endpoint, and a
  non-secret credential identity (OAuth uses stable account/org/credential
  metadata; API-key identity is a SHA-256 fingerprint).
- A later generation seeds the preserved replacement history only when every
  lineage field matches; mismatched or legacy lineage strips the stale replay
  while retaining textual LCM state and starts a fresh lineage. Empty results,
  missing credentials, ineligible models, and remote failures never install
  stale replay data (`lastNativeReplayStatus` records the reason).
- `test/native-replay.test.ts` covers lineage gating and reconstruction;
  `test/native-replay.integration.test.ts` is the opt-in live suite
  (`LCM_LIVE_INTEGRATION=1`, `bun run test:integration`) requiring configured
  OpenAI-Codex credentials; README records the 2026-07-28 live canary
  (`openai-codex/gpt-5.3-codex-spark`, persisted + reconstructed + accepted
  continuation).
- Known limits and follow-ups are registered with dispositions in the "Gap
  disposition" section (GAP-005/006/008–016, GAP-026, GAP-029). Part II must
  not weaken replay lineage or persisted reconstruction guarantees (its
  constraint list below).

## Retrieval tool contract (implemented)

Implemented in `src/tools.ts`: one extension tool `lcm_expand`.

Parameters:

- `artifactId`: numeric string;
- `depth`: integer with a small maximum, default 1;
- `includeRaw`: boolean, default false.

Behavior:

1. Resolve through `ctx.sessionManager.getArtifactPath`; never scan other
   sessions.
2. Parse only `schema: "omp-lcm-node/v1"` as a node.
3. Emit node summary, `artifact://` child links, and `artifact://` raw source
   links.
4. Recursively inspect child nodes up to `depth`.
5. Detect cycles defensively.
6. Do not inline raw artifact content unless `includeRaw=true`.
7. Even with `includeRaw=true`, bound output and direct the model to
   `read artifact://ID:<range>` for large content.
8. On malformed or missing artifacts, return a useful error without throwing
   outside the tool.

Exact retrieval and search remain ordinary OMP operations:

```text
read artifact://17
read artifact://17:1-300
grep "validateToken" artifact://17
```

Oversized tool results are spilled to session artifacts by OMP itself at
ingestion time (`spillLargeResultToArtifact`, default 50 KiB threshold); the
captured entries retain `details.meta.truncation.artifactId`, so the exact
full text of any spilled result is reachable through `read artifact://N` in
this session's store. The plugin adds no capture-time file pipeline; see
Part III, "OMP artifact spill".

## Abort discipline (implemented)

Pass `event.signal` to every summary call. Check it:

- before source selection;
- before each artifact write;
- immediately after each artifact write;
- before and after each LLM request;
- before parent condensation;
- before rendering;
- before returning the custom result.

An abort returns cancel. It never triggers deterministic fallback or built-in
compaction.

## Implementation history — Part I (completed)

Waves 1–6 of the original plan were completed and verified; each task below
was done and its acceptance criteria were met. Full evidence: `VERIFICATION.md`
and the commit history (oldest first):

```text
48d16d0 docs: add LCM plugin implementation plan
531cec6 docs: correct standalone plugin implementation plan
a291c3b feat(plugin): release standalone LCM compaction plugin
19667c8 docs: document marketplace installation and updates
920a695 fix(marketplace): use a unique marketplace namespace
24e498b chore(release): bump plugin to 0.1.1
11de739 feat(compaction): expose LCM diagnostics and artifact traversal
700f94b fix(tool): register lcm_expand with current OMP API
50460b3 fix(cli): show artifact DAG in lcm dump
f624201 fix(cli): report running plugin version
922f675 feat(compaction): preserve provider-native replay
c73b1d7 chore(release): bump plugin to 0.1.6
884dcf3 fix(compaction): use OMP native replay orchestration
a367283 fix(replay): prove persisted OMP reconstruction
```

| Wave | Deliverables | Status |
|---|---|---|
| 1 | `package.json`, `.omp-plugin/marketplace.json`, `.gitignore`, `tsconfig.json`, `biome.json`, `LICENSE` | Done |
| 2 | `src/contracts.ts` + tests; `src/source.ts` + tests; `src/summarize.ts` + tests | Done |
| 3 | `src/dag.ts` + tests; `src/render-context-full.ts` + tests; `src/render-snapcompact.ts` + tests | Done |
| 4 | `src/controller.ts`, `src/config.ts`, `src/index.ts`; `src/tools.ts` + tests | Done |
| 5 | `test/helpers.ts`, `test/controller.test.ts`, `test/remote-interception.test.ts`, `test/lifecycle.test.ts` | Done |
| 6 | `README.md`, top-level `src/index.ts` comments, `bun pm pack` inspection | Done |
| Post-wave | `test/omp-profile.test.ts` (OMP profile smoke), provider-native replay (`src/replay-lineage.ts`, `test/native-replay.test.ts`, `test/native-replay.integration.test.ts`), `GAPS.txt`, `VERIFICATION.md` | Done |

Verifiers A–G (standalone boundary, retention/reachability, fail-closed,
snapcompact purity, convergence/bounds, abort/write safety, retrieval smoke)
ran fresh read-only at 0.1.0; every concrete defect found was fixed at the
source and re-verified (details in `VERIFICATION.md`). Final Part I validation
(`bun test`, `bun run typecheck`, `bun run check`, `bun pm pack`, and the
context-full/snapcompact user-path smoke tests) passed; the 0.1.6 live canary
evidence is in README.

## Implementation history — Part II and Part III (completed 2026-08-01)

Part II was delivered in small concurrent waves under the supervisory
instruction (max eight workers, one module plus its unit test per worker,
read-only verifiers after implementation):

| Wave | Deliverables | Status |
|---|---|---|
| 1 | `src/batch.ts` (batch planner), `src/deadline.ts` (deadline helpers), `src/pool.ts` (bounded order-preserving pool), `src/tiers.ts` (tier resolution + budgets), `deterministicSummary` in `src/summarize.ts`, each with tests | Done |
| 2 | `src/config.ts` settings extension (five new `omp.settings`), `package.json` metadata, `src/controller.ts` integration (status contract, tier chains, leaf stage, DAG stage, replay/render gates), `test/controller-deadline.test.ts` | Done |
| 3 | README settings/tiers/deadline documentation | Done |
| 4 | Part III: `src/explore.ts` (type-aware exploration), `src/tools.ts` (`lcm_describe`, `lcm_grep`, shared bounded walker), fixtures and tests | Done |
| Verifiers | Fresh read-only audits of Part II and Part III (12 and 7 checks) | Done; all defects fixed at the source and re-verified |

Contract clarification recorded during Wave 2 (approved): `injected.complete`
is the transport seam for tier-model calls and does NOT bypass tier selection;
only `injected.summaryCall` does. Verifier-discovered defect D1 (configured
`leafSummaryModel`/`rootSummaryModel` were parsed but never consumed) was
fixed with `preferredChain` in `src/tiers.ts` plus controller and test
changes; verifier-discovered Part III gaps (unregistered tools, missing-raw
reporting in `lcm_grep`, README docs) were closed. Final validation: `bun test`
→ 185 pass, 2 skip (live integration, gated on `LCM_LIVE_INTEGRATION=1`),
0 fail; `bun run typecheck` clean; `bun run check` clean. The 22-chunk
wall-clock regression completes in ~1.35 s against a 1.4 s injected budget.
Evidence: `VERIFICATION.md`, `GAPS.txt` (GAP-021/026/031 dispositions), and
the commit history.

---

# Part II — Deadline-Safe Tiered LCM Summarization (implemented 2026-08-01)

This part is **implemented and verified** (the imperative wording below
describes the original task, which is complete; "Confirmed failure" is the
historical record of the 0.1.8 timeout this part fixes). It supersedes the
following Part I passages: "Summary and convergence contract — Default model
call" (leaf/root tiers), "DAG construction contract — Leaf generation"
(consolidated batches), and "Remote observability — LcmRuntimeStatus"
(deadline/batch/tier fields). Existing preserved-state and artifact schemas
stay compatible; old DAG nodes are not rewritten. See "Implementation history
— Part II and Part III" for the delivery record.

## Part II — Goal

Make `session_before_compact` reliably return an LCM compaction result before
OMP's fixed 30-second extension-handler timeout while preserving exact source
artifacts, useful semantic summaries, bounded active roots, and
provider-native replay.

The implementation must combine:

1. consolidated summary batches;
2. bounded parallel model calls;
3. OMP's online `TINY` model role for leaf summaries;
4. a stronger model for information-dense root condensation;
5. an internal deadline with deterministic fallback; and
6. status updates that begin before expensive work.

The result is incomplete if LCM merely makes model calls faster but can still
time out and silently fall through to built-in OMP compaction.

## Part II — Confirmed failure

A real compaction on version 0.1.8 produced:

- an OMP `Extension handler timed out` warning for `session_before_compact`;
- the fixed OMP handler timeout of 30,000 ms;
- 22 `lcm-raw` artifacts;
- zero `lcm-node` artifacts;
- `{}` from `/lcm status`; and
- `(no roots recorded)` from `/lcm dump`.

LCM had captured the discarded source, then entered the sequential leaf-summary
loop in `src/controller.ts`. OMP stopped waiting before leaf summarization
completed. Because OMP's timeout occurs outside the plugin's `try/catch`, the
plugin returned no custom compaction result and OMP performed built-in
compaction.

The current latency shape is approximately:

```text
N raw chunks
  -> N serial leaf-summary calls
  -> serial DAG repair/condensation calls
  -> provider-native replay
  -> rendering and status assignment
```

For the observed session, `N = 22`. This cannot reliably fit inside 30
seconds.

## Part II — Non-negotiable constraints

1. Keep this repository a standalone OMP plugin. Do not patch OMP or increase
   its handler timeout.
2. Continue using the public `session_before_compact` extension hook.
3. Preserve every discarded `SessionEntry` exactly in immutable `lcm-raw`
   artifacts.
4. Keep every raw artifact transitively reachable from a current DAG root.
5. Never truncate model input silently. Reduce batch size or use deterministic
   fallback.
6. Never use unbounded `Promise.all()` for provider calls.
7. Preserve source order regardless of model response order.
8. A provider failure, rate limit, invalid summary, or internal deadline must
   not cause fallthrough to built-in compaction.
9. User/session cancellation must retain current cancellation semantics.
10. Do not use OMP's local title-model inference path for LCM source
    summaries.
11. Do not weaken provider-native replay or the persisted reconstruction
    guarantees covered by GAP-004 (closed; see "Gap disposition").
12. Do not predict artifact IDs. Save artifacts and use returned IDs.

## Part II — Architecture decision

### Tiered model policy

Use different model tiers according to information risk:

| Stage | Default model | Rationale |
|---|---|---|
| Leaf/source batch summary | OMP online `TINY` role | Many independent calls; exact source remains retrievable from raw artifacts |
| DAG root repair | `SMOL`, then active | Repair affects model-visible retained context |
| DAG root condensation | `SMOL`, then active | This is the principal semantic information bottleneck |
| Provider-native replay | Active provider/model | Must preserve provider-specific replay lineage |
| Deadline/error fallback | Deterministic, no model | Must complete without network dependency |

Model resolution order:

```text
leaf: tiny -> smol -> active -> deterministic
root: smol -> active -> tiny -> deterministic
```

`tiny` means the configured online OMP model role resolved from available
catalog models. It does not mean the local title models handled by
`tinyModelClient`.

### Why local title models are excluded

OMP's local title models are optimized for short titles, not faithful
transcript compression. Their current path preprocesses input to approximately
2,000 characters and caps generation at 1,024 new tokens. Sending a 12K-token
source chunk through that path would discard most of the source before
summarization. Local CPU inference may also be slower than a fast hosted
model.

The online `TINY` role is acceptable only when the resolved model:

- supports text input;
- has credentials;
- has enough context for the complete batch plus prompt and output reserve;
  and
- supports the configured summary output bound.

### Consolidated leaf batches

Keep raw artifact chunking independent from summary request batching.

Current raw chunks remain retrieval units. Adjacent raw chunks are packed into
larger semantic summary batches. One leaf node may reference multiple raw
artifact IDs and all source entry IDs covered by those artifacts.

```ts
interface SummaryBatch {
  input: string;
  rawArtifactIds: string[];
  sourceEntryIds: string[];
  estimatedInputTokens: number;
}
```

Batch invariants:

- inputs contain complete serialized entries;
- entries are never split across batches;
- source order is stable;
- raw artifact IDs occur in exactly one new leaf batch;
- source entry IDs occur in exactly one new leaf batch;
- opaque provider metadata remains omitted from model input and preserved in
  raw artifacts; and
- the chosen model's context bound is respected.

Use a conservative model-aware input budget:

```text
min(configured maximum batch input,
    model context window - system prompt reserve - output reserve)
```

Initial defaults:

- maximum summary-batch input: 48,000 estimated tokens;
- prompt/output reserve: at least 8,000 tokens;
- minimum viable batch: one complete source entry;
- leaf output target: 2,048 tokens.

If a single serialized entry exceeds the model budget, do not truncate it.
Produce the bounded deterministic leaf summary and retain the exact entry in
its raw artifact.

For 22 roughly 12K-token raw chunks, a 48K input budget should reduce
approximately 22 leaf requests to 6 summary requests.

### Bounded concurrency

Run independent leaf batches through a fixed worker pool. Default concurrency:
4.

Requirements:

- allocate the result array before starting workers;
- write each result at its original batch index;
- never infer source order from completion order;
- stop dequeuing new model calls after the internal model-stage deadline;
- allow already-started calls to observe the composed abort signal; and
- deterministically summarize every batch that did not receive a valid model
  result.

Do not start one request per batch simultaneously. Provider-level throttling
would make timeout behavior less predictable.

### Deadline hierarchy

LCM must finish before OMP's 30-second timeout without depending on changes
to OMP.

Initial budgets:

| Budget | Default |
|---|---:|
| Total internal handler deadline | 24,000 ms |
| Leaf model stage | 14,000 ms |
| Individual leaf call | 9,000 ms |
| Root model stage | 4,000 ms |
| Native replay/render reserve | 4,000 ms |
| OMP safety margin | 6,000 ms |

These values are implementation defaults, not guarantees that every model call
consumes its entire allowance. The total handler deadline is authoritative.

Compose cancellation sources but preserve their meaning:

- `event.signal` aborted: user/session cancellation; return `{ cancel: true }`;
- internal model-stage deadline: stop model work and use deterministic
  summaries;
- total internal handler deadline: skip optional model work and native replay
  if necessary, render a valid local LCM compaction, and return it;
- provider request failure: ordinary per-batch convergence failure, then
  fallback.

The plugin must retain enough time after model work to save DAG nodes, render
the compaction, assign status, and return `{ compaction: result }`.

### DAG reduction

Implement in two steps.

#### Step 1: reduce leaf count before DAG construction

Consolidated batches should normally create a small number of leaves. This
alone reduces the serial condensation work currently performed by `buildDag()`.

#### Step 2: parallelize independent DAG groups if measurements require it

If root condensation remains material, reduce independent groups by levels:

```text
roots -> ordered groups of at most 4
      -> condense groups concurrently with a bounded pool
      -> restore group order
      -> repeat until root count and token bounds pass
```

Do not change the DAG shape in the first implementation unless deadline tests
show consolidated leaves are insufficient. A smaller, verified change is
preferred.

## Part II — Configuration

Extend `LcmConfig` in `src/config.ts` and `omp.settings` in `package.json`.

Proposed settings:

```json
{
  "leafSummaryModel": "tiny",
  "rootSummaryModel": "smol",
  "summaryConcurrency": 4,
  "summaryBatchInputTokens": 48000,
  "handlerDeadlineMs": 24000
}
```

Allowed model tier values:

```text
tiny | smol | active
```

Required validation and bounds:

| Setting | Bounds/default |
|---|---|
| `leafSummaryModel` | enum; default `tiny` |
| `rootSummaryModel` | enum; default `smol` |
| `summaryConcurrency` | integer 1–8; default 4 |
| `summaryBatchInputTokens` | integer 12,000–96,000; default 48,000 |
| `handlerDeadlineMs` | integer 10,000–27,000; default 24,000 |

Do not expose an option above 27 seconds. LCM needs a margin below OMP's
30-second deadline.

If public OMP role resolution is unavailable in the installed supported
version, use an explicit plugin model selector resolved through the public
model registry. Do not import unpublished OMP source paths or call the local
title-model client.

Document the settings and fallback chains in `README.md` only after the
behavior is implemented and smoke-tested.

## Part II — Runtime status contract

Populate status before raw capture and before any network request.

Add fields to `LcmRuntimeStatus`:

```ts
lastOutcome?: "running" | "success" | "cancelled";
lastStartedAt?: string;
lastElapsedMs?: number;
lastLeafSummaryModel?: string;
lastRootSummaryModel?: string;
lastRawChunkCount?: number;
lastSummaryBatchCount?: number;
lastSummaryConcurrency?: number;
lastCompletedModelSummaryCount?: number;
lastDeterministicFallbackCount?: number;
lastDeadlineFallbackCount?: number;
lastDeadlineStage?: "leaf" | "root" | "native-replay" | "total";
```

Status transitions:

1. At hook entry: set `lastOutcome = "running"`, `lastStartedAt`, and reset
   stale error/deadline fields.
2. After capture: record raw chunk/artifact counts.
3. After batch planning: record batch count, selected models, and concurrency.
4. During fallback: increment deterministic and deadline counters.
5. Before return: assign final roots/result metadata, elapsed time, and
   `lastOutcome = "success"`.
6. On user cancellation: set `lastOutcome = "cancelled"` and preserve the
   cancellation reason.
7. On a fatal local invariant or artifact error: set the error and return
   `{ cancel: true }`; never return `undefined`.

`/lcm status` must never remain `{}` after a compaction attempt reaches the
plugin.

## Part II — Implementation phases

### Phase A: pure planning primitives

Create or extend focused modules for logic that does not require an OMP
runtime context.

1. Add model-tier and summary-execution configuration types.
2. Add a pure adjacent-chunk batch planner.
3. Add a generic order-preserving bounded worker pool.
4. Add composed deadline helpers that distinguish user cancellation from
   internal expiration.
5. Add deterministic conversion from an unfinished batch to a valid leaf.

Acceptance:

- batch planning is deterministic;
- no entry is lost, duplicated, split, or reordered;
- concurrency never exceeds the configured limit;
- results retain input order when promises resolve out of order; and
- an internal deadline produces a result for every input item.

### Phase B: model resolution

1. Resolve leaf and root roles once per compaction attempt.
2. Check model context capacity before assigning a batch.
3. Resolve credentials for the selected model rather than reusing the active
   model's key.
4. Reuse the active model only through the documented fallback chain.
5. Record concrete `provider/model` identifiers in status.
6. Keep model selection injectable in controller tests.

Acceptance:

- configured `tiny` uses the online TINY role when available;
- no local title-model client is invoked;
- missing TINY credentials fall back without cancelling compaction;
- a too-small TINY context causes smaller batching or tier fallback, never
  truncation; and
- provider-native replay continues using the active provider and credential
  lineage.

### Phase C: controller integration

Modify `src/controller.ts` at the source of the timeout.

1. Start runtime diagnostics immediately on hook entry.
2. Capture exact raw artifacts as today.
3. Plan consolidated summary batches.
4. Replace the sequential leaf loop with bounded concurrent execution.
5. Construct ordered leaves with multiple raw artifact references where
   applicable.
6. Pass the remaining deadline to DAG summarization and repair.
7. Skip or bound optional model work when the deadline reserve is reached.
8. Preserve rendering and native replay behavior when time remains.
9. Always complete status before returning.

Acceptance:

- 22 observed-style chunks no longer produce 22 serial model calls;
- LCM returns a custom compaction result before its internal deadline;
- every raw artifact remains reachable through a leaf/root chain;
- returned roots remain within existing count/token bounds; and
- built-in OMP compaction is not reached after LCM accepts the event.

### Phase D: optional DAG parallel reduction

Only implement this phase if Phase C's timing test cannot reliably retain the
required margin.

1. Partition roots into stable adjacent groups.
2. Condense groups with the same bounded executor.
3. Preserve group order and child linkage.
4. Apply deterministic condensation to unfinished groups.
5. Repeat by level until bounds hold.

Acceptance:

- root count and token invariants remain unchanged;
- all children are reachable exactly once from the next level;
- concurrency is bounded; and
- output ordering is deterministic.

### Phase E: commands and documentation

After the runtime path works:

1. Extend `/lcm status` and `/lcm dump` output through the existing status
   object.
2. Add settings metadata to `package.json`.
3. Document tier meanings, defaults, deadlines, and fallback behavior in
   `README.md`.
4. State explicitly that local title models are not used for source
   summarization.
5. Explain that increasing OMP's extension timeout is neither required nor
   supported by this plugin.

## Part II — Test plan

All tests in this part are bound by the plan-wide "Testing integrity — no
cheating" rules. In particular: the controller deadline regression must
include at least one real wall-clock delay case with adversarial fakes
(out-of-order completion, deadline expiry, provider failure), and consolidated
batch planning must be asserted from inputs and contracts, never from the
implementation's own output.

### Batch planner tests

Add tests covering:

1. empty input;
2. one chunk;
3. exact budget boundary;
4. adjacent chunks crossing a boundary;
5. a single oversized entry;
6. raw artifact and source entry provenance;
7. stable ordering; and
8. opaque provider metadata omission in model-visible input.

### Bounded executor tests

Use deferred promises and an active-call counter.

Assert:

- active calls never exceed configured concurrency;
- at least two calls overlap when concurrency is greater than one;
- deliberately reversed completion order still returns ordered results;
- synchronous rejection does not strand workers;
- deadline expiration stops new calls; and
- unfinished items receive deterministic results.

### Model policy tests

Inject a fake registry with TINY, SMOL, and active models.

Assert:

- leaf resolution prefers TINY;
- root resolution prefers SMOL;
- missing credentials move to the next tier;
- insufficient context reduces batch capacity or moves tiers;
- local title inference is never called; and
- selected concrete models are recorded in status.

### Controller deadline regression

Reproduce the real failure shape with 22 raw chunks.

Use delayed fake completion calls and assert:

1. summary requests are consolidated;
2. concurrency never exceeds four;
3. responses complete out of order without reordering leaves;
4. selected calls exceed the model-stage deadline;
5. unfinished batches receive deterministic summaries;
6. `beforeCompact()` returns `{ compaction: ... }`, not `undefined` or
   `{ cancel: true }`;
7. elapsed time remains below the configured internal deadline;
8. every raw ID is reachable from returned roots;
9. `/lcm status` data is non-empty and reports the fallback; and
10. native replay is used when budget remains and safely skipped/degraded when
    it does not.

Use fake timers only if Bun's timer behavior remains representative. At least
one test must run against real short wall-clock delays to prove the race and
abort wiring.

### Existing behavior regression

Run and retain coverage for:

- source selection boundaries;
- context-full rendering;
- snapcompact rendering;
- DAG preservation across generations;
- deterministic summary convergence;
- remote interception/fail-closed behavior;
- native replay lineage;
- persisted OMP reconstruction and transmitted provider payload; and
- command/status rendering.

### Live smoke test

Run an opt-in real OMP integration scenario with enough discarded history to
generate more than four raw chunks.

Observe and record:

- `session_before_compact` completes without an OMP timeout warning;
- `/lcm status` reports `success`;
- `/lcm dump` contains current roots;
- raw and node artifacts both exist;
- the elapsed time is below 24 seconds under normal provider conditions;
- at least one leaf used the configured TINY role; and
- the next provider request contains the expected reconstructed native replay
  payload when eligible.

A live provider result is evidence for the configured credential/model path
only; deterministic tests remain authoritative for all fallback branches.

## Part II — Verification commands

Run focused checks first, then the repository suite:

```text
bun test test/source.test.ts test/summarize.test.ts test/controller.test.ts test/dag.test.ts
bun test test/native-replay.test.ts test/native-replay.integration.test.ts
bun run typecheck
bun run check
bun test
```

Run the opt-in live integration only when configured credentials are
available:

```text
LCM_LIVE_INTEGRATION=1 bun test test/native-replay.integration.test.ts
```

Finally install/update the plugin locally and exercise a real `/compact`
followed by:

```text
/lcm status
/lcm dump
```

The implementation is not complete if only unit tests pass but the real hook
still exceeds OMP's timeout.

## Part II — Rollout and compatibility

1. Keep the existing preserved-state and artifact schemas compatible.
2. Do not rewrite old DAG nodes.
3. New leaf nodes may reference multiple raw artifacts; existing traversal
   already treats `rawSources` as an array.
4. Defaults must work without requiring users to configure a TINY role:
   resolution falls through to SMOL, active, then deterministic.
5. Record model and fallback diagnostics so provider-specific regressions are
   visible.
6. Release as a point version after the live smoke test passes.
7. Update the local marketplace installation and verify the loaded version
   before the final compaction smoke test.

## Part II — Completion criteria

All of the following must be true:

- The sequential per-chunk summary loop is removed.
- Adjacent raw chunks are consolidated into model-aware summary batches.
- Leaf summaries use the online TINY role by default when suitable.
- Root condensation uses a stronger tier by default.
- Provider calls use bounded concurrency.
- Model and total-stage deadlines leave a margin below OMP's 30-second limit.
- Unfinished model work becomes deterministic summaries rather than hook
  failure.
- Status is populated before expensive work and finalized on every handled
  path.
- Exact raw source remains artifact-backed and transitively reachable.
- Provider-native replay reconstruction/transmission guarantees remain
  covered.
- The 22-chunk regression returns a custom LCM compaction within budget.
- A real OMP compaction produces both raw and node artifacts with non-empty
  `/lcm status` and `/lcm dump` output.

---

# Part III — Paper-aligned extensions and explicit non-goals (2026-08-01)

This part records the review of `LCM_Paper_3.tex` against the implemented
package and the installed OMP 17.1.8 packages. It contains (a) the scope
reduction made necessary by OMP's own artifact-spill mechanism, (b) two tools
(**implemented 2026-08-01**: `lcm_describe` and `lcm_grep`), (c) one deferred
schema follow-on (`fileRefs`), and (d) explicit non-goals written down so they
are never implemented by accident. The acceptance criteria below were
proposals; candidates A and B are now implemented and verified (see
"Implementation history — Part II and Part III"), `fileRefs` remains
deferred per its gate, and every non-goal stays unimplemented.

## OMP artifact spill — the storage half of large-file handling is already solved

Verified in the installed OMP 17.1.8 packages:

- `spillLargeResultToArtifact` in
  `@oh-my-pi/pi-coding-agent/src/tools/output-meta.ts`: any tool result above
  `tools.artifactSpillThreshold` (default 50 KiB) is saved in full through
  `sessionManager.saveArtifact(fullText, toolName)` — the same session
  artifact store and ID sequence the plugin uses for `lcm-raw` and `lcm-node`.
- The inline content is replaced with head+tail middle elision (default 20 KiB
  head + 20 KiB tail; `tools.artifactHeadBytes`/`artifactTailBytes`) plus a
  `[raw output: artifact://N]` footer. Elided bytes stay recoverable; if the
  save fails the result is still truncated and the full output is never
  re-exposed.
- Streaming bash/python/ssh/eval paths use the same mechanism
  (`streaming-output.ts` `enforceInlineByteCap`, `bash-executor.ts`); the
  `read` tool is excluded and bounds its own output.

Consequences for this plugin:

- `captureRawSource` serializes the exact session entry, which retains
  `details.meta.truncation.artifactId`. `lcm-raw` JSONL therefore already
  references the full text of any oversized tool result, and leaf summarizers
  see only the bounded elided view. There is no double truncation and no
  context blowup from file-sized tool results; the Part II timeout regression
  comes from conversational history, not file dumps.
- A plugin-side capture-time file pipeline (re-chunking, external storage,
  exploration summaries generated during capture) is **not proposed**: it
  would duplicate OMP's spill, add work inside the hook deadline, and change
  the artifact contract for no lossless gain.

What OMP's spill does **not** provide — the real remaining gap:

- a type-aware Exploration Summary (schema/shape extraction for JSON/CSV/SQL,
  structural analysis for code, LLM summary for prose); OMP's elision is
  deterministic head+tail only;
- file-ID propagation through plugin summary nodes (OMP's compaction
  `<files>` summary tracks paths only, `pi-agent-core/src/compaction/utils.ts`).

## Candidate A — `lcm_describe` (proposed)

Metadata lookup that does not expand content, matching paper Appendix B, plus
the lazy type-aware exploration summary for spilled artifacts.

Parameters: `artifactId` (numeric string); `explore` (boolean, default false).

Behavior:

1. Resolve through `ctx.sessionManager.getArtifactPath`; never scan other
   sessions.
2. Node artifact (`schema: "omp-lcm-node/v1"`): emit kind, level, children
   IDs, raw source IDs, source entry count, token count, and full summary
   text. No traversal.
3. Raw artifact: emit entry count, byte size, and token estimate; bounded
   head/tail preview.
4. Any other artifact (an OMP-spilled tool result): metadata only unless
   `explore=true`.
5. `explore=true` on a spilled artifact: generate a bounded, type-aware
   exploration summary — JSON/CSV/SQL get schema+shape extraction (keys,
   types, counts, samples); code gets structural analysis (function
   signatures, class hierarchy); unstructured text gets one LLM summary call
   using the active model and key, with abort propagation. Model failure or
   abort degrades to a bounded head/tail preview, never an error.
6. Output bounded (same ceiling family as `lcm_expand`); malformed or missing
   artifacts return a useful error without throwing outside the tool.

Files: extend `src/tools.ts`; add `src/explore.ts` for the type-aware
   dispatcher; tests in `test/tools.test.ts` plus exploration fixtures.

Acceptance (proposal):

- metadata-only mode performs no model call;
- node metadata matches the artifact content;
- exploration summaries are type-appropriate for JSON, CSV, SQL, code, and
  prose fixtures;
- exploration mode propagates abort and degrades to bounded head/tail on
  failure;
- output is bounded; malformed/missing artifacts produce contained errors.

## Candidate B — `lcm_grep` (proposed)

Regex search across the full immutable history reachable from current roots,
matching paper Appendix B: results grouped by the covering summary node,
paginated, optionally scoped to one node's subtree.

Parameters: `pattern` (string, required); `summaryId` (numeric string,
optional); `limit` (integer, default 50, max 200); `caseSensitive` (boolean,
default false).

Behavior:

1. Locate current roots by scanning the session branch for the latest
   compaction entry whose preserve data contains `ompLcmArtifactsV1`; parse
   and validate roots (resume-safe, no in-memory dependency). If none, return
   a helpful "no LCM history" result.
2. Traverse the DAG from the roots — or from `summaryId` when given — using
   the same bounded traversal, node caps, and cycle defense as `lcm_expand`.
3. For each reachable raw artifact, resolve its path and regex-search its
   content with a per-artifact byte cap; report truncation if an artifact was
   scanned partially.
4. Group matches by the covering node ID; honor `limit` for pagination; keep
   total output bounded.
5. Invalid regex, missing artifact, or traversal limit produce contained,
   actionable errors.

Acceptance (proposal):

- matches are grouped by covering node ID;
- `summaryId` narrows the search to one subtree;
- `limit` pagination works and total output stays bounded;
- roots are discovered from persisted branch state, including after reload;
- invalid patterns and missing artifacts return contained errors, not throws.

## Deferred — `fileRefs` propagation through DAG nodes

Optional additive field on `LcmNodeArtifactV1` recording spilled-artifact IDs
referenced by the entries a node covers. Gate: only after Candidate A ships
and shows real use. Old nodes are never rewritten; parsers already tolerate
absent optional fields. This is the plugin-side remnant of the paper's
file-ID propagation; OMP's `<files>` path tracking is not a substitute but is
sufficient until then.

## Explicit non-goals — do not implement

These features from the paper were considered and rejected. They are recorded
so future workers do not implement them. Reopening any of them requires
amending this plan with a written reason.

### Do not implement: capture-time large-file pipeline

Plugin-side chunking, external storage, or exploration-summary generation at
capture time. OMP's spill already provides artifact-backed storage of the
full output, the plugin's raw capture already references it, and capture-time
work would burn hook-deadline budget for no lossless gain. See "OMP artifact
spill" above.

### Do not implement: LLM-Map / Agentic-Map operator tools

Engine-side parallel map primitives are task-execution tooling, not context
management; this repository is a compaction plugin. The paper's design
requires engine infrastructure (persistent job state, pessimistic locking,
exactly-once execution) that no public extension API provides, and OMP
already owns delegation and parallelism surface. Part II's bounded worker
pool stays internal to summarization; it is not a seed for a map operator.

### Do not implement: scope-reduction delegation guard

Enforcing `delegated_scope`/`kept_work` on sub-agent spawns requires
intercepting OMP's built-in `Task` tool, which no public extension hook
allows; a wrapper would be bypassable by other delegation paths and would
constitute monkey-patching, which the standalone boundary forbids. OMP's own
delegation behavior is outside this plugin's control.

### Do not implement: deferred compaction execution and atomic background swap

Requires public OMP lifecycle hooks (deferred compaction execution outside
`session_before_compact`, atomic installation) and a transaction API; neither
exists. Tracked as GAP-017 and GAP-012. Part II is the standalone substitute:
finish deterministically inside the 30-second handler budget.

### Do not implement: embedding index over summaries

The paper itself does not implement it and states regex-plus-DAG traversal
suffices. Embeddings are derived content that would amplify the at-rest
sensitivity concerns of GAP-011, add storage and per-content model cost, and
contradict the paper's own critique of decontextualized retrieval. No
lossless invariant requires it.

### Do not implement: `lcm_expand` sub-agent-only restriction

The paper restricts expansion to sub-agents to prevent uncontrolled context
growth. Our `lcm_expand` is already bounded (depth 8, 48 nodes, 12 000-char
output, 1 500-char raw previews) and directs the model to ranged `read` for
large content, so the hazard the restriction guards against does not exist
here. A caller-role check is not exposed by the extension API, and the
restriction would add a sub-agent round trip to every quick lookup. Keep
main-agent access; document the divergence.

## Part III acceptance (implemented 2026-08-01)

- [x] `lcm_describe`: metadata-only mode performs no model call; exploration
      mode is type-aware, bounded, abort-safe.
- [x] `lcm_grep`: searches reachable raw history, grouped by covering node,
      paginated, `summaryId`-scoped, resume-safe.
- [x] `fileRefs` propagation implemented only after `lcm_describe` shows real
      use (still deferred; parsers tolerate the absent optional field).
- [x] Explicit non-goals above remain unimplemented and are cited whenever a
      worker proposes any of them.
- [x] README documents `lcm_describe`, `lcm_grep`, and the OMP spill
      dependency.
- [x] All Part III tests conform to the plan-wide testing-integrity rules:
      real artifact store, adversarial fakes, no prose-equality or
      golden-answer assertions, labeled fixtures, unique live sentinels.

---

# Part IV — Reliability hardening (implemented 2026-08-01)

This part hardens the credential, replay, and diagnostics paths. All items
are implemented, unit-tested, and live-verified where the harness permits
(`VERIFICATION.md` Parts IV and V).

## GAP-006 closure — credential refresh and authenticated retry

Leaf/root summary calls run through `withAuth(keySource, attempt)` where
`keySource` is the registry's auth-retry resolver
(`modelRegistry.resolver(model, sessionId)`; storage-level resolver and a
refresh-aware `getApiKey` wrapper are degraded fallbacks) seeded with the
tier snapshot via `seedApiKeyResolver`: 401 force-refreshes the same
account, 403/usage-limit rotates to a sibling, static keys keep
single-attempt behavior. The tier availability gate resolves through the
same resolver (`resolveApiKeyOnce`) when one exists, and the keyless
sentinel (`kNoAuth`, `"N/A"`) is rejected instead of being treated as a
usable key. Failure text is recorded in `lastLeafModelError` /
`lastRootModelError`; tier verdicts in `lastTierRejections`.

## GAP-005 closure — session context on the v1 replay path

The direct v1 `requestOpenAiRemoteCompaction` call forwards the session id
through the published options argument (`{ sessionId }`); the v2
orchestrator path already forwarded it. (17.2.3 signature: signal is the
5th parameter, options the 6th.)

## GAP-016 closure — replay degradation is surfaced

Native replay failures (exception or internal-deadline skip) emit one
bounded notification per run (`LCM native replay failed: <reason>`) while
the textual LCM result still completes. No encrypted payload content is
included.

## GAP-027 closure — diagnostics survive reloads

Each run persists a bounded diagnostics snapshot as a session custom entry
(`lcm-status`, version 1, status copied at write time); registration
hydrates the most recent entry, so `/lcm status` and `/lcm dump` keep
reporting the last run across reloads. Persistence is best-effort and never
fails compaction.

## GAP-029 closure — OMP 17.2.3+

All `@oh-my-pi/*` pins moved to 17.2.3. The auth-retry APIs used exist in
both 17.1.8 and 17.2.3, so the plugin remains compatible with both lines.

## GAP-032 — tier metadata wrapper passed as the model (defect, fixed)

`resolveSummaryModel` returns a `TierModelInfo` wrapper; the controller
passed the wrapper to `complete()`, so every tier-resolved call died with
`Unhandled API: undefined` before any HTTP request — the actual cause of
the 2026-07-28/08-01 smoke failures. The controller now unwraps the
candidate model; a unit regression asserts the completion receives it
including its `api` field.

## Part IV verification

- `bun test` → 202 pass, 3 live-skips, 0 fail; typecheck clean; changed
  files biome-clean.
- Live (OMP 17.2.3, real openai-codex/gpt-5.3-codex-spark credentials,
  minimal-context rounds): `LCM_LIVE_INTEGRATION=1 bun test
  test/native-replay.integration.test.ts` → 5/5 pass; the new live test
  asserts `lastSummaryQuality: "model"`, zero deterministic fallback, no
  leaf/root errors, replay preserved.
- Coverage boundary: the live suite exercises the resolver gate +
  credential path end to end; GAP-005/016/027 are unit-verified (Spark
  selects the v2 replay path and replay succeeds live).

# Part V — Next step: orphan-window hardening and automated release canary

## Goal

Eliminate the only remaining correctness gap that can damage the session
artifact store on a real failure path (GAP-012/023), and automate the live
release gate (GAP-030).

## Work items

1. **Shrink the artifact orphan window (GAP-012 mitigation).** Raw JSONL
   artifacts are currently written during capture, before summaries run; an
   abort/error mid-run leaves every written artifact orphaned forever (the
   17.2.3 `ArtifactManager` has no delete API, so rollback and GC are not
   implementable from the extension boundary). Change the write order:
   keep capture chunks in memory (~1 MB for a 22-chunk run) and write each
   raw artifact immediately before its leaf node, so a failure before the
   first node write leaves zero artifacts. The remaining window (leaf nodes
   written, roots not installed) is a handful of nodes.
2. **Orphan accounting (GAP-023 observability).** `ArtifactManager.listFiles`
   exists; at run start, count files not referenced by any installed node or
   root and report `lastOrphanArtifactCount` in status (detection without
   deletion until OMP exposes a safe delete API).
3. **Automated live release canary (GAP-030).** Add a script that packs the
   plugin, installs it into a clean temporary OMP profile, and runs the
   opt-in live integration (`LCM_LIVE_INTEGRATION=1`) against configured
   credentials, failing the release if any step fails. Wire it into the
   release checklist so the manual live loop becomes the exception, not the
   rule.

## Part V acceptance

- [x] A mid-run abort before the first node write leaves zero new artifacts
      in the session store (regression test with a store that records
      writes).
- [x] Failed runs report the count of unlinked artifacts in
      `lastOrphanArtifactCount`; linked artifacts are never counted.
- [x] The canary script runs pack → clean-profile install → live
      integration in one command and exits non-zero on any failure.
- [x] `bun test` (unit + existing live) and typecheck stay green.

## Part V non-goals

- Full transactional writes, rollback, and orphan GC remain blocked on a
  public OMP delete/transaction API (GAP-012/023 dispositions unchanged).
- No change to the deterministic fallback semantics (GAP-015) or to
  session-scoped artifact IDs (GAP-020).

---

## Gap disposition — full register (rolled in from GAPS.txt, 2026-08-01)

`GAPS.txt` remains the operational register with the full per-gap prose; this
section is authoritative for dispositions and is the plan's single index of
what will be done, what will not be done, and what is explicitly accepted.

Statuses used below:

- **closed** — implemented and verified (evidence pointer given);
- **planned** — assigned to a part of this plan;
- **proposed** — assigned to a Part III candidate that is not yet committed;
- **non-goal** — deliberately not implemented (Part III "Explicit non-goals");
- **blocked** — requires a public OMP API or core change that does not exist;
  no schedule without it;
- **accepted** — limitation accepted and documented; closing it is optional
  future work.

Severity definitions: P0 = release blocker (correctness or integration not
proven for production); P1 = high (material continuity, security,
availability, or cost risk; needs an explicit acceptance decision); P2 =
medium (important limitation with a usable workaround); P3 = low
(maintainability, ergonomics, or observability weakness that does not
normally threaten retained history).

### P0 — release blockers (both closed)

**GAP-003 — Replay identity gated only by provider name (closed).** Native
replay now persists `ompLcmNativeReplayLineageV1` beside encrypted
replacement history; prior history is seeded only when provider, model, API
variant, mechanism, endpoint, and credential identity all match. See Part I
"Provider-native replay".

**GAP-004 — Actual OMP context reconstruction integration-tested (closed).**
Deterministic integration coverage persists replacement history through
OMP's `SessionManager`, reopens the session, runs real `buildSessionContext`
reconstruction, and proves the next provider request carries the exact
preserved native history. See Part I and `test/native-replay.test.ts`.

### P1 — high severity

**GAP-005 — Codex session and compaction context is not forwarded (closed
2026-08-01).** The direct v1 replay request now passes the session id through
OMP's published options argument (`{ sessionId }`); the v2 orchestrator path
already forwarded it. Regression test asserts the value reaches the v1 call.
See Part IV.

**GAP-006 — Credential refresh and authenticated retry are missing (closed
2026-08-01).** Leaf/root summary calls run through `withAuth` with the
registry's auth-retry resolver (`modelRegistry.resolver(model, sessionId)`;
refresh-aware `getApiKey` wrapper as degraded fallback), seeded with the
snapshot via `seedApiKeyResolver`: 401 force-refreshes, 403/usage-limit
rotates, failures are recorded in status instead of swallowed. The tier gate
shares the resolver and rejects the keyless sentinel. Live-verified on codex
Spark with zero deterministic fallback. See Part IV.

**GAP-007 — OpenAI V2 streaming replay and migration were missing (closed).**
Eligible models delegate replay to OMP's published orchestrator, which
selects streaming V2 ahead of V1; lineage distinguishes V1/V2 and records the
mechanism's effective endpoint. See Part I "Provider-native replay".

**GAP-008 — Generic remote compaction endpoints are bypassed (open).**
Returning a complete extension result bypasses configured generic remote
endpoints; the plugin restores only eligible OpenAI Responses native
compaction. Disposition: needs an explicit precedence policy between LCM
summarization, OpenAI native replay, and generic endpoints; unscheduled.

**GAP-009 — Existing archived encrypted metadata cannot be backfilled into
replay (open, blocked).** Old encrypted fields are not a valid ordered
replacement history. Disposition: backfill only via a validated OMP
reconstruction API; otherwise the first native replay is documented as a new
lineage boundary (README). Unscheduled.

**GAP-010 — Native replay payload size is not bounded or reported (open).**
Replacement history has no byte ceiling; diagnostics report item count only.
Disposition: measure serialized bytes and item types before installation,
define a defensive maximum, degrade to textual LCM when oversized;
unscheduled.

**GAP-011 — Raw artifacts contain plaintext sensitive data at rest (open).**
Raw JSONL preserves exact prompts, tool results, and file content.
Disposition: define the artifact store's security boundary, verify
permissions, support encryption at rest where OMP permits, add retention and
secure deletion; unscheduled. Part III cites this gap in the embedding-index
non-goal.

**GAP-012 — Multi-artifact compaction is not transactional (open, blocked).**
Raw/leaf/parent writes are sequential; later failures can orphan earlier
writes. Disposition: use an OMP transaction API if one becomes public; until
then, record pending writes and add safe orphan discovery/GC that never
deletes reachable artifacts. Part III references this in the async-compaction
non-goal. Part V mitigates the write-order window: raw artifacts are written
only immediately before their leaf node, so an abort before the first node
write leaves zero artifacts; rollback/GC still blocked on a public OMP
transaction API.

**GAP-013 — Local semantic summarization and native replay are sequential
(closed).** Eligible compactions previously paid both latencies serially.
Disposition: CLOSED 2026-08-01 — replay now starts immediately after capture
and runs concurrently with leaf summarization and DAG condensation under the
same absolute internal deadline and cancellation signal (src/controller.ts
`runNativeReplay`); failure is fail-isolated and the textual LCM result stays
authoritative. Regression coverage: promise-barrier ordering test in
test/controller.test.ts, reserve-guard test in test/controller-deadline.test.ts,
and the existing never-settling-replay deadline test.

**GAP-014 — Fail-closed behavior trades continuity for availability (open,
accepted as default).** Accepted failures return `{ cancel: true }` and never
fall through. Disposition: keep fail-closed; add actionable error codes,
operator guidance, and a deliberate command to disable LCM before retrying
built-in compaction; never fall through silently.

**GAP-015 — Deterministic fallback preserves bytes, not semantic continuity
(open).** Fallback stores a bounded excerpt; the active model may lose
decisions outside the excerpt. Disposition: visible degradation warnings,
targeted retry of failed leaves, and a repair command that rebuilds degraded
nodes when a summarization model is available; unscheduled.

**GAP-032 — Tier-resolved models were passed to the completion wrapped in
metadata (closed 2026-08-01).** `resolveSummaryModel` returns a
`TierModelInfo` wrapper without an `api` field; the controller passed the
wrapper to `complete()`, so every tier-resolved call died with
`Unhandled API: undefined` before any HTTP request — the actual cause of
the 2026-07-28/08-01 smoke failures. The controller now unwraps the
candidate model; a unit regression asserts the completion receives it
including its `api` field, and a live test asserts model-quality summaries
on codex Spark. See Part IV.

### P2 — medium severity

**GAP-016 — Native replay degradation is not proactively surfaced (closed
2026-08-01).** Native replay failures (exception or internal-deadline skip)
now emit one bounded notification per run while the textual LCM result still
completes; no encrypted payload content is included. See Part IV.

**GAP-017 — No deferred compaction execution
(non-goal, blocked).** Compaction runs synchronously in `session_before_compact`.
Disposition: requires public OMP lifecycle and transaction APIs; Part III
"Explicit non-goals" records it as do-not-implement; Part II (finish inside
the 30-second budget) is the standalone substitute.

**GAP-018 — Handoff, shake, and automatic pre-handoff injection are
unsupported (non-goal, blocked).** Disposition: requires public handoff/shake
lifecycle hooks and a safe source-injection contract; recorded as out of
scope in Part I decisions and Part III non-goals.

**GAP-019 — Automatic renderer selection cannot observe hidden OMP guidance
(accepted).** `renderer=auto` uses public strategy, custom-instruction, and
model-vision information only. Disposition: documented; explicit renderer for
deterministic behavior (README, Part I).

**GAP-020 — Artifact IDs are session-scoped rather than globally unique
(accepted, blocked).** Disposition: needs a public globally unique artifact
identifier; external references must carry session identity; documented.

**GAP-021 — Retrieval is available but not guaranteed (open, partially
closed).** The model must choose to expand/search; it can answer from
incomplete summaries. Disposition: Part III Candidate B (`lcm_grep`) shipped
and reduces the guessing burden (node-grouped, paginated search of reachable
raw history); policy-driven retrieval triggers still need public hooks;
unscheduled beyond that. `lcm_grep` patterns are agent-supplied tool arguments
(semi-trusted, grep-tool norm); catastrophic-backtracking regexes are the
caller's responsibility, matching ordinary OMP grep behavior.

**GAP-022 — Dump and expansion limits can hide deep or wide history (open).**
Disposition: keep limits, expose truncation counts and continuation root IDs
so callers can expand the omitted branch deliberately; unscheduled.

**GAP-023 — No orphan garbage collection or retention policy (open).**
Disposition: reachability analysis from installed roots, dry-run reporting,
configurable retention, safe deletion integrated with the session store;
assigned to Part V (orphan accounting + orphan-window hardening) for the
observability half; safe deletion remains blocked on a public OMP delete
API. Part V ships the observability half: `lastOrphanArtifactCount` reports
files not referenced by any installed node or root at run start; safe
deletion remains blocked on a public OMP delete API.

**GAP-024 — Preserve-state schema evolution has no migration framework
(open).** Disposition: versioned migrations, forward-compatible unknown
fields, upgrade tests from every released schema; unscheduled.

**GAP-025 — Snapcompact integration is summary-only (accepted).** No visual
frames are generated from raw history; historical images remain only in raw
artifacts. Disposition: documented as summary-only; frame generation is a
non-goal for this plugin.

**GAP-026 — Replay and compaction telemetry is minimal (open, partially
closed).** Disposition: Part II's runtime status contract landed and adds
deadline, batch, tier, and fallback fields (`lastStartedAt`, `lastElapsedMs`,
`lastLeafSummaryModel`, `lastRootSummaryModel`, `lastRawChunkCount`,
`lastSummaryBatchCount`, `lastSummaryConcurrency`,
`lastCompletedModelSummaryCount`, `lastDeadlineFallbackCount`,
`lastDeadlineStage`); full structured metrics (latency per stage, payload
sizes, retry counts) remain unscheduled.

### P3 — lower severity

**GAP-027 — Runtime diagnostics are ephemeral (closed 2026-08-01).** Each
run persists a bounded diagnostics snapshot as a session custom entry
(`lcm-status`, version 1, status copied at write time); registration
hydrates the most recent entry, so `/lcm status` and `/lcm dump` keep
reporting the last run across reloads. Round-trip covered by unit tests.
See Part IV.

**GAP-028 — Settings persistence probes multiple manager methods dynamically
(open).** Disposition: bind to one published typed settings API and add a
reload-persistence test; unscheduled. Referenced from Part I settings
section.

**GAP-029 — The extension remains tightly coupled to OMP 17.1.8 (closed
2026-08-01).** All `@oh-my-pi/*` pins moved to 17.2.3; the suite and the
live harness run against 17.2.3, and the auth-retry APIs used exist in both
17.1.8 and 17.2.3, keeping the plugin compatible with both lines.
See Part IV.

**GAP-030 — No automated live release canary (closed 2026-08-01).**
Disposition: automated release canary script (`bun run canary`) packs the
plugin, installs it into a clean temporary OMP profile, and runs the opt-in
live integration (`LCM_LIVE_INTEGRATION=1`) failing the release on any step
failure; manual live loops remain documented as the exception.

**GAP-031 — No type-aware exploration summaries for oversized tool results
(closed 2026-08-01).** OMP spills oversized results with head+tail elision
only. Disposition: Part III Candidate A (`lcm_describe` explore mode)
shipped: type-aware exploration summaries for JSON/CSV/SQL/code/prose with
bounded output and abort-safe degradation (`src/explore.ts`, `src/tools.ts`,
`test/explore.test.ts`, `test/tools.test.ts`).

### Ranking notes (condensed)

- Exact raw preservation prevents irreversible conversational data loss, but
  it does not make every semantic or provider-native continuity failure
  harmless.
- Textual LCM fallback is the primary safety net for native replay failure.
- P0 items must be closed before claiming production-ready provider-native
  replay; P1 items require explicit risk acceptance even after P0 closure.
- Some P2 limitations require new public OMP APIs and cannot be solved
  entirely inside a standalone extension today.

---

## Completion checklist

### Part I (implemented and verified 2026-08-01)

- [x] Repository is a standalone OMP plugin package.
- [x] All implementation files are under this repository's `src/`.
- [x] All tests are under this repository's `test/`.
- [x] No OMP source checkout was modified.
- [x] No local relative OMP source dependency exists.
- [x] `package.json` exports `src/index.ts` and declares `omp.extensions`.
- [x] Marketplace metadata points to `nszceta/omp-lcm-inspired-compaction`.
- [x] Plugin settings support `auto`, `context-full`, and `snapcompact`
      renderers.
- [x] First activation archives exact history covered by earlier non-LCM
      compactions.
- [x] Repeated compaction captures only newly discarded source after the
      latest LCM generation.
- [x] Recent entries at and after `firstKeptEntryId` are not archived
      prematurely.
- [x] Exact source is stored as JSONL artifacts.
- [x] Every active summary reference is appended by deterministic code.
- [x] Every raw source remains transitively reachable from a current root.
- [x] Active roots never exceed four.
- [x] Preserve data contains bounded roots, not the full DAG.
- [x] Normal, aggressive, and deterministic levels guarantee convergence.
- [x] Context-full result strips old snapcompact and remote preserve payloads.
- [x] Snapcompact receives only synthetic LCM root messages.
- [x] Snapcompact never unfolds a previous raw archive.
- [x] Snapcompact archive survives context rebuild.
- [x] Complete hook results bypass built-in remote endpoint compaction.
- [x] Complete hook results bypass provider-native remote compaction by
      control flow.
- [x] Model-summary failure uses deterministic fallback without built-in
      compaction fallthrough.
- [x] Abort, boundary failure, and artifact failure cancel without
      fallthrough.
- [x] Artifact IDs continue safely after session resume.
- [x] `lcm_expand`, `read artifact://ID`, selectors, and grep recover retained
      history.
- [x] `bun test`, `bun run typecheck`, and `bun run check` pass.
- [x] Packed package contains only intended standalone plugin files.
- [x] README never instructs users to modify OMP source.
- [x] Provider-native replay is lineage-gated, persisted, reconstructed, and
      live-canary verified (GAP-003/004/007 closed; `GAPS.txt`).

### Part II (implemented and verified 2026-08-01)

- [x] The sequential per-chunk summary loop is removed.
- [x] Adjacent raw chunks are consolidated into model-aware summary batches.
- [x] Leaf summaries use the online TINY role by default when suitable.
- [x] Root condensation uses a stronger tier by default.
- [x] Provider calls use bounded concurrency.
- [x] Model and total-stage deadlines leave a margin below OMP's 30-second
      limit.
- [x] Unfinished model work becomes deterministic summaries rather than hook
      failure.
- [x] Status is populated before expensive work and finalized on every handled
      path.
- [x] Exact raw source remains artifact-backed and transitively reachable.
- [x] Provider-native replay reconstruction/transmission guarantees remain
      covered.
- [x] The 22-chunk regression returns a custom LCM compaction within budget
      (real wall-clock harness; ~1.35 s against a 1.4 s injected budget,
      `test/controller-deadline.test.ts`).
- [x] A real OMP compaction produces both raw and node artifacts with
      non-empty `/lcm status` and `/lcm dump` output — proven by the
      deterministic controller/lifecycle/profile suites and the 22-chunk
      wall-clock regression; the live opt-in smoke (`LCM_LIVE_INTEGRATION=1`
      and a manual `/compact` against configured credentials) remains the
      environment-gated final step per the plan's rollout section.

### Open gap register

- [x] Every open gap in the "Gap disposition" section is closed, assigned to
      planned work, or explicitly accepted with a written reason. GAP-026 is
      partially closed by the Part II status contract; GAP-021 is partially
      addressed by Candidate B; GAP-012/023 mitigation and GAP-030 are
      assigned to Part V (next step). Remaining dispositions unchanged,
      accepted.

### Part III (implemented 2026-08-01 — candidates A and B)

- [x] Candidate A: `lcm_describe` tool (metadata + lazy type-aware
      exploration).
- [x] Candidate B: `lcm_grep` tool (node-grouped, paginated, scoped search).
- [x] Deferred: `fileRefs` in DAG nodes stays deferred (gate: Candidate A
      shows real use; parsers tolerate the absent optional field).
- [x] Out-of-scope features recorded in Part III stay unimplemented (audit
      point).

### Part IV (implemented and verified 2026-08-01)

- [x] Summary calls run through OMP's auth-retry resolver under `withAuth`
      (GAP-006 closed): 401 force-refresh, 403/usage-limit rotation,
      failure text recorded in status.
- [x] Tier availability gate shares the resolver (`resolveApiKeyOnce`) and
      rejects the keyless sentinel `"N/A"`.
- [x] GAP-005 closed: the v1 replay request forwards the session id.
- [x] GAP-016 closed: replay failures emit one bounded notification per run.
- [x] GAP-027 closed: `/lcm status` and `/lcm dump` survive reloads via the
      persisted `lcm-status` session entry.
- [x] GAP-029 closed: all `@oh-my-pi/*` pins moved to 17.2.3.
- [x] GAP-032 closed: the tier model wrapper is unwrapped before the
      completion call.
- [x] `bun test` → 202 pass, 3 live-skips, 0 fail; typecheck clean.
- [x] Live integration 5/5 on a real codex Spark subscription (OMP 17.2.3):
      model-quality summaries, zero deterministic fallback, replay preserved.

### Testing integrity (plan-wide)

- [x] Plan-wide testing-integrity policy recorded ("Testing integrity — no
      cheating").
- [x] Part II tests conform to the testing-integrity policy (real wall-clock
      deadline regression, adversarial fakes, no golden answers, no fake
      timers, no skips).
- [x] Part III tests conform to the testing-integrity policy (labeled
      hand-written fixtures, seam-asserted no-model-call paths, adversarial
      degrade paths).

---

## Decisions subagents must not reopen

- The implementation lives entirely in this repository.
- OMP is a package dependency and read-only reference, not an implementation
  target.
- No core hook metadata change is allowed.
- No new OMP strategy is added.
- Existing `session_before_compact` custom results are the interception
  mechanism.
- The plugin fails closed after accepting an event.
- Context-full and snapcompact are the supported renderers.
- `auto` renderer uses preparation settings, model image capability, and
  public custom instructions.
- Artifacts are the immutable source store.
- Preserve data contains only bounded roots.
- Artifact IDs are numeric and session-scoped.
- IDs are appended after model output.
- Snapcompact receives synthetic roots and no previous snapcompact/provider-
  native archive.
- The active root maximum and snapcompact frame maximum are both four.
- Provider-native replay uses OMP's published orchestrator, gated by the
  plugin's lineage record; stale or mismatched replay is stripped, never
  guessed.
- OMP's extension-handler timeout is not changed; LCM must finish inside it.
- Local title-model inference is never used for LCM source summaries.
- Leaf batches are consolidated; leaf model calls run through a bounded
  order-preserving pool with deterministic fallback for unfinished batches.
- Handoff, shake, off, async atomic swaps, and multi-write transactions are
  outside this standalone version.
- Part III candidates (`lcm_describe`, `lcm_grep`) are proposals, not
  commitments; Part II lands first.
- OMP's artifact spill is the large-result storage mechanism; the plugin adds
  no capture-time file pipeline.
- LLM-Map/Agentic-Map, the scope-reduction delegation guard, deferred
  compaction execution, embedding indexes, the `lcm_expand` sub-agent
  restriction, and capture-time file handling are out of scope; the reasons
  are recorded in Part III "Explicit non-goals".
- Tests must be legitimate evidence: no assertion weakening, golden-answer
  copying, friendly-only fakes, fake-timer races, silent skips,
  prose-equality assertions, or fixed-sentinel live tests; see "Testing
  integrity — no cheating".
