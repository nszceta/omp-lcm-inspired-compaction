# Verification log

Date: 2026-07-28
Package: `omp-lcm-inspired-compaction` 0.1.0
OMP package line: 17.1.8

## Custom OMP test profile

```text
$ bun run test:omp-profile
$ bun test test/omp-profile.test.ts
1 pass
0 fail
4 expect() calls
Ran 1 test across 1 file.
```

The profile loads `src/index.ts` through `createLcmExtension`, registers `session_before_compact`, and registers `lcm` plus `lcm status` against a fake OMP extension API and session artifact manager.

## Full tests and static checks

```text
$ bun run typecheck
$ bun test
24 pass
0 fail
71 expect() calls
Ran 24 tests across 11 files.
$ bun run test:omp-profile
1 pass
0 fail
4 expect() calls
Ran 1 test across 1 file.
$ bun run check
check: passed
root biome: ok
```

The suite covers contracts, source selection/chunking, summary convergence, DAG bounds/write safety, context-full rendering, snapcompact source purity and preserve stripping, controller fail-closed behavior, remote interception, lifecycle persistence, retrieval tooling, and extension registration.

## Package contents

```text
$ bun pm pack
Total files: 13
$ tar -tzf omp-lcm-inspired-compaction-0.1.0.tgz | sort
package/LICENSE
package/README.md
package/package.json
package/src/config.ts
package/src/contracts.ts
package/src/controller.ts
package/src/dag.ts
package/src/index.ts
package/src/render-context-full.ts
package/src/render-snapcompact.ts
package/src/source.ts
package/src/summarize.ts
package/src/tools.ts
$ rm omp-lcm-inspired-compaction-0.1.0.tgz
```

The inspected tarball contains only package metadata, README, license, and `src/`; tests, PLAN.md, node_modules, credentials, and generated tarballs are excluded. The generated tarball was removed after inspection.

## Verifier evidence and fixes

Three fresh read-only verifiers inspected the final repository. The standalone-boundary verifier found consistent 17.1.8 registry dependencies, public OMP imports only, valid marketplace metadata, and no upstream checkout or local filesystem dependency. The fail-closed verifier exercised the controller/remote/snapcompact/tool paths with 9 passing targeted tests and confirmed success returns complete extension results while accepted failures return cancellation; foreign snapcompact preserve keys were removed and a regression assertion was added. The retention verifier identified permissive prior IDs, unvalidated prior roots, and a raw-content write lacking a post-save abort check; these were fixed in `source.ts` and `dag.ts`, then the full checks above were rerun.

## Executed behavior evidence

- Source tests cover first activation, matching-generation repeated capture, split-turn prefixes, recent-entry exclusion, exact JSONL, stable chunks, missing boundaries, abort, canonical artifact IDs, and raw artifact ordering.
- DAG/lifecycle tests cover immutable leaf/parent artifacts, bounded roots, invalid write IDs, repeated generations, and monotonic artifact growth. DAG now validates prior root IDs/metadata and checks abort after raw-content writes.
- Controller and remote tests cover complete custom results, cancellation on accepted failures, deterministic fallback, remote-enabled context-full interception, and zero built-in remote-call fallthrough.
- Snapcompact tests verify rejection before writes for text-only models, synthetic root-only input, four-frame cap, plugin-only preserve state, foreign-key stripping, and no previous raw archive unfolding.
- Tool tests verify bounded recursive expansion, raw-link behavior, malformed/missing artifact errors, and cycle defense.

## Scope notes

The standalone package uses published OMP extension APIs and does not modify an OMP checkout. Artifact IDs remain session-scoped. Handoff, shake, off, asynchronous atomic swaps, and multi-write transactions remain outside the public standalone extension boundary described in PLAN.md.

---

# Verification log — Part II and Part III (2026-08-01)

Package: `omp-lcm-inspired-compaction` 0.2.0 (OMP package line 17.1.8)

## Full tests and static checks (final state)

```text
$ bun test
185 pass
2 skip (live integration, gated on LCM_LIVE_INTEGRATION=1)
0 fail
Ran 187 tests across 20 files.
$ bun run typecheck
tsc --noEmit: clean
$ bun run check
check: passed
root biome: ok
```

New test files: `test/batch.test.ts` (12), `test/deadline.test.ts` (16),
`test/pool.test.ts` (8), `test/tiers.test.ts` (28), `test/config.test.ts`
(12), `test/controller-deadline.test.ts` (8), `test/explore.test.ts` (25),
`test/tools.test.ts` additions (30 total incl. lcm_describe/lcm_grep).

## Deadline regression evidence (real wall clock, no fake timers)

`test/controller-deadline.test.ts` reproduces the 0.1.8 failure shape: 22 raw
chunks (~12K tokens each) with a 1.4 s injected internal deadline
(`handlerDeadlineMs` via the `deps.config` seam; production bounds are
10–27 s):

- leaf requests consolidated from 22 to 6 (48K-token batches, 4 chunks each);
- concurrent model calls never exceed 4;
- completions resolve out of order and leaves preserve chunk order;
- a completion outliving the 816 ms leaf stage aborts; the batches it covered
  plus never-started batches become deterministic summaries
  (`lastDeadlineStage: "leaf"`, `lastDeadlineFallbackCount >= 1`);
- `beforeCompact` returns `{ compaction }` (never `undefined`, never
  `{ cancel: true }` on internal expiry);
- measured elapsed 1352/1380/1361 ms across three runs, asserted `< 1400 ms`
  inside the test;
- all 22 raw artifact IDs are reachable from the returned roots (test walks
  node `children`/`rawSources`);
- `/lcm status` shape is non-empty: `lastOutcome: "success"`,
  `lastRawChunkCount: 22`, `lastSummaryBatchCount: 6`,
  `lastSummaryConcurrency: 4`, `lastCompletedModelSummaryCount: 3`,
  `lastLeafSummaryModel` records the concrete provider/model label.

Native replay gating: with budget remaining, replay runs and
`lastNativeReplayStatus: "preserved"`; when the replay/render reserve is
reached, replay is skipped with `lastNativeReplayStatus: "failed"` and error
`"internal deadline reached; native replay skipped"`, and the result remains
a valid LCM `{ compaction }`.

## Tier policy evidence

- `@`-prefixed role aliases only (`resolve("@tiny")`/`resolve("@smol")`),
  verified against OMP source (`model-resolver.ts` `getModelRoleAlias`);
  local title models are never invoked (no import or call path exists).
- Leaf chain tiny → smol → active; root chain smol → active → tiny; missing
  credentials and too-small context windows advance the chain; the
  configured `leafSummaryModel`/`rootSummaryModel` reorders the chain first
  (`preferredChain`, regression-tested after verifier defect D1).

## Fresh read-only verifier outcomes

Part II verifier (12 checks): PASS — all checks satisfied; 109/109 targeted
tests pass, typecheck clean. Real defect D1 (configured tier settings parsed
but never consumed) fixed at the source with `preferredChain` and regression
tests. Minor deviation D2 accepted and recorded: the root model stage uses
the remaining budget up to `total − replay/render reserve` rather than a
fixed 4 s slice; the total deadline stays authoritative and the margin below
OMP's 30 s limit is preserved.

Part III verifier (7 checks): PASS on handler behavior and testing integrity;
two gaps closed after the audit: the two new tools are now registered in
`src/index.ts` (asserted by `test/omp-profile.test.ts`), and `lcm_grep`
reports unreadable raw artifacts as `(missing)` instead of silently skipping
them. README now documents `lcm_describe`, `lcm_grep`, and the OMP
artifact-spill dependency.

## Known accepted limitations (Part II/III, retained)

- `lcm_grep` patterns are agent-supplied tool arguments (semi-trusted,
  grep-tool norm); catastrophic-backtracking regexes are the caller's
  responsibility (GAP-021 disposition).
- The live opt-in smoke (real OMP `/compact` against configured credentials)
  remains environment-gated; the deterministic wall-clock regression is the
  authoritative fallback evidence for the 30-second budget claim.

# Verification log — Part IV (2026-08-01): credential-path fix, live-verified

Package: `omp-lcm-inspired-compaction` 0.2.1 (deps pinned to OMP 17.2.3)

## Defects closed

1. **GAP-006 (credential refresh/authenticated retry).** Leaf/root summary
   calls previously handed `complete()` a one-shot `getApiKey` snapshot; a
   stale OAuth bearer failed fast with no refresh, and the error was swallowed
   into the deterministic fallback. Now every summary call runs through
   `withAuth(keySource, attempt)` where `keySource` is
   `modelRegistry.resolver(model, sessionId)` (storage-level `resolver` and a
   refresh-aware `getApiKey` wrapper are degraded fallbacks), seeded with the
   tier snapshot via `seedApiKeyResolver`. 401 → force-refresh same account;
   403/usage-limit → sibling rotation; last error recorded in
   `lastLeafModelError`/`lastRootModelError`.
2. **GAP-032 (tier wrapper passed as the model).** `resolveSummaryModel`
   returns a `TierModelInfo` wrapper; the controller passed the wrapper to
   `complete()`, so every tier-resolved call died with `Unhandled API:
   undefined` before any HTTP request — the actual cause of the 2026-07-28 and
   2026-08-01 smoke failures, invisible because errors were swallowed.
   Controller now unwraps (`leafModel.model.model`); regression test asserts
   the fake completion receives the candidate including its `api` field.
3. **GAP-029 (17.1.8 coupling).** All `@oh-my-pi/*` pins moved to 17.2.3;
   suite and live harness run against 17.2.3; the auth-retry APIs used exist
   in both 17.1.8 and 17.2.3.
4. **Error observability.** `lastLeafModelError`, `lastRootModelError`, and
   `lastTierRejections` (`stage:role:label:reason`, capped at 8) surface the
   swallowed failure text; cleared on each run start.

## Full tests and static checks (final state)

```text
$ bun test
195 pass
3 skip (live integration, gated on LCM_LIVE_INTEGRATION=1)
0 fail
Ran 198 tests across 21 files.
$ bun run typecheck
tsc --noEmit: clean
```

New test file: `test/credential-path.test.ts` (7) — seeded-resolver refresh,
bare-registry force-refresh wrapper, exhausted-auth recording + clearing,
non-auth no-retry, missing-key, tier rejections, and the GAP-032 unwrap
regression.

`bun run check` reports only pre-existing `noExplicitAny` diagnostics in
files untouched by this work (`src/index.ts`, `test/helpers.ts` and siblings;
biome 2.5.6 with the recommended preset); changed files (`src/controller.ts`,
`src/tiers.ts`, `test/credential-path.test.ts`) are clean.

## Live verification — real codex Spark subscription (OMP 17.2.3)

`LCM_LIVE_INTEGRATION=1 bun test test/native-replay.integration.test.ts`
(2026-08-01, real `openai-codex/gpt-5.3-codex-spark` OAuth credentials,
`compaction.keepRecentTokens: 1` minimal-context rounds):

```text
5 pass
0 fail
34 expect() calls
Ran 5 tests across 1 file. [35.92s]
```

New live test `produces model leaf/root summaries (not deterministic
fallback) on Spark` asserts, after a real compaction:

- `lastSummaryQuality: "model"` (was `"deterministic-fallback"` in all 3
  pre-fix smoke rounds);
- `lastCompletedModelSummaryCount > 0` and
  `lastDeterministicFallbackCount === 0`;
- `lastLeafModelError` / `lastRootModelError` undefined;
- `lastNativeReplayStatus: "preserved"` (replay unaffected).

Existing live replay-lineage tests still pass: Spark→Luna lineage switch,
encrypted V2 replacement history, generation chaining with
`lastNativeReplaySeeded: true`.

## Known accepted limitations recorded in this pass

- Tier resolution gate behavior: registries exposing `resolver` gate on the
  resolver path (shared with the call); bare `getApiKey` registries keep the
  snapshot gate, and per-candidate rejections are recorded in status
  (`lastTierRejections`).
- The repo-wide biome `check` failure (legacy `any` sites) predates this
  work and is left as debt; changed files are clean.

# Verification log — Part V (2026-08-01): reliability follow-ups, live-verified

Package: `omp-lcm-inspired-compaction` 0.2.2 (OMP 17.2.3)

## Fixes in this pass

1. **Tier gate shares the resolver machinery (GAP-006 follow-up).** The
   availability gate now resolves through `modelRegistry.resolver` via
   `resolveApiKeyOnce` when the registry exposes one, so the gate and the call
   use the same credential path (initial → force-refresh → rotate); bare
   `getApiKey` registries keep the snapshot gate. The registry's
   keyless-provider sentinel (`kNoAuth`, "N/A") is rejected instead of being
   treated as a usable key — previously a keyless candidate could be
   "resolved" and seeded into the call.
2. **GAP-005 closed.** The direct v1 replay request now forwards the session
   id through OMP's published options argument (`{ sessionId }`); regression
   test asserts the value reaches the v1 call. (17.2.3 signature: signal is
   the 5th parameter, options the 6th.)
3. **GAP-016 closed.** Native replay failures (exception or internal-deadline
   skip) now emit a bounded notification (`LCM native replay failed:
   <reason>`) once per run while the textual LCM result still completes.
4. **GAP-027 closed.** Each run persists a bounded diagnostic snapshot as a
   session custom entry (`lcm-status`, version 1, status copied at write
   time); registration hydrates the most recent entry into live status, so
   `/lcm status` and `/lcm dump` keep reporting the last run across reloads.
   Persistence is best-effort and never fails compaction.

## Full tests and static checks

```text
$ bun test
202 pass
3 skip (live integration, gated on LCM_LIVE_INTEGRATION=1)
0 fail
Ran 205 tests across 21 files.
$ bun run typecheck
tsc --noEmit: clean
```

New/updated tests: `test/tiers.test.ts` credential-gate suite (resolver gate,
`kNoAuth` rejection on both paths), `test/native-replay.test.ts` (v1 session
forwarding, replay-failure notification, status persistence), and
`test/omp-profile.test.ts` (status hydration across a simulated reload).
Changed files remain biome-clean apart from pre-existing legacy `any` sites.

## Live verification — real codex Spark subscription (OMP 17.2.3)

```text
$ LCM_LIVE_INTEGRATION=1 bun test test/native-replay.integration.test.ts
5 pass
0 fail
34 expect() calls
Ran 5 tests across 1 file. [24.57s]
```

All five tests pass after the fixes: model-quality leaf/root summaries on
Spark (zero deterministic fallback), Spark→Luna lineage switch, encrypted V2
replacement history across two compactions, and both offline reconstruction
tests.

Coverage boundary: the live Spark suite exercises fix 1 (resolver gate +
credential path) end to end. Fixes 2–4 (GAP-005 v1 session forwarding,
GAP-016 replay-failure notification, GAP-027 status persistence) are
unit-verified — the live run's Spark session selects the v2 replay path and
replay succeeds, so neither the v1 request shape nor the failure notification
fires on it.

# Verification log — Orphan-window hardening and automated release canary (2026-08-01, plan Part V)

Package: `omp-lcm-inspired-compaction` 0.2.2 (OMP 17.2.3)

## Fixes in this pass

1. **Artifact orphan window shrunk (GAP-012 mitigation).** Raw JSONL
   artifacts are no longer written during capture. `captureRawSource` keeps
   chunks in memory (deferred mode: `saveArtifact` optional, zero writes)
   and each raw artifact is written immediately before its leaf node inside
   `buildDag` (`NewLeaf.rawContents`, one `checkAbort` per write), so an
   abort before the first node write leaves zero new artifacts. The
   remaining window (leaf nodes written, roots not installed) is a handful
   of nodes. Regression test: a mid-run abort (summary call aborts the event
   signal and rejects) returns `{ cancel: true }` with an empty artifact
   store.
2. **Orphan accounting (GAP-023 observability).** New `src/orphans.ts`:
   `orphanStoreFor` adapts the session manager / `ArtifactManager`
   (methods stay `this`-bound — the real manager reads private fields), and
   `countOrphanArtifacts` walks root reachability (children + rawSources)
   over files matching `{id}.{toolType}.log`, bounded to 1000 node reads,
   abort-safe, never throwing on malformed content. The controller reports
   `lastOrphanArtifactCount` at run start (best-effort, never fails the
   run). Failed runs carry the count; linked artifacts are never counted
   (unit suite plus a controller regression that seeds a linked node+raw
   plus an orphan and asserts exactly the orphan is counted).
3. **Automated live release canary (GAP-030 closed).** `scripts/canary.ts`
   (`bun run canary`) packs the plugin, extracts the tarball, installs the
   packed directory into a clean temporary OMP profile (fresh `OMP_PROFILE`;
   profile dir and temp state removed on the way out — cleanup runs because
   failures are thrown, not `process.exit`-ed), verifies the install via
   `omp plugin list`, then runs the opt-in live integration
   (`LCM_LIVE_INTEGRATION=1`), exiting non-zero on any step failure.

## Full tests and static checks

```text
$ bun test
222 pass
3 skip (live integration, gated on LCM_LIVE_INTEGRATION=1)
0 fail
1097 expect() calls
Ran 225 tests across 22 files. [5.45s]
$ bun run typecheck
tsc --noEmit: clean
```

New tests: `test/orphans.test.ts` (reachability, malformed/missing content,
abort, read cap, `this`-bound store adaptation), controller regressions in
`test/controller.test.ts` (abort-before-first-node leaves zero artifacts;
failed runs report `lastOrphanArtifactCount` with linked files excluded;
stores without `listFiles` leave the field undefined), `test/dag.test.ts`
(rawContents write order and precedence), `test/source.test.ts` (deferred
capture writes nothing), `test/batch.test.ts` (`chunkIndexes` provenance).
Changed files are biome-clean apart from pre-existing legacy `any` sites in
`controller.ts`/`helpers.ts`/`controller.test.ts` (present on HEAD).

## Canary run — fail-closed without credentials (2026-08-01)

```text
$ bun run canary
[canary] pack: ok (omp-lcm-inspired-compaction-0.2.2.tgz)
[canary] install: ok (profile lcm-canary-<rand>)   # Linked from /tmp/omp-lcm-canary-*/package
[canary] plugin list: ok (omp-lcm-inspired-compaction installed)
[canary] FAILED at live integration: exit code 1   # No API key found for openai-codex
$ echo $?
1
```

The environment has no OpenAI-Codex credentials, so the live step fails
closed exactly as designed: pack, extract, clean-profile install, and
`plugin list` verification all pass, the live step exits non-zero, and no
`lcm-canary-*` profile directory or temp state remains after the run. A
credentialed run is the release gate; the manual live loop remains the
documented exception.

# Verification log — OMP 30s handler-wall hotfix (2026-08-01, GAP-034)

Package: `omp-lcm-inspired-compaction` 0.2.3 (OMP 17.2.3)

## Field failure

Resumed session log (2026-08-01 19:17:41, `~/.omp/logs/omp.*.log`):

```json
{"level":"warn","message":"Extension handler timed out",
 "extensionPath":".../omp-lcm-inspired-compaction/src/index.ts",
 "event":"session_before_compact","timeoutMs":30000}
```

`/lcm version` answered v0.2.3 (extension loaded, commands dispatch), but
`/lcm status` returned `{}`: the aborted run never persisted status, the
harness fell back to built-in compaction, and the run's artifacts were left
unreachable.

## Root cause

OMP's extension runner aborts `session_before_compact` handlers after a
fixed 30 000 ms. The plugin's internal deadline (default 24 s) bounded only
the leaf/root summary calls; the provider-native replay call, config
loading, the API-key preflight, capture, orphan accounting, tier
resolution, the DAG write loop, and snapcompact rendering were bounded only
by OMP's 30 s signal. A slow native compaction call ran the handler into
the wall.

## Fix (GAP-034 closure)

- Prelude deadline (4 s from handler start) races config loading; expiry
  falls back to default config instead of failing the run.
- Absolute total deadline (`Deadline.at(startedAt + handlerDeadlineMs)`, max
  27 s < 30 s) created before any other await; its signal is wired into the
  API-key preflight, capture, orphan accounting, tier resolution, root model
  calls, the native replay call, and snapcompact rendering.
- `raceWithSignal` in src/deadline.ts guarantees a bound even against
  signal-ignoring callees (underlying promise is consumed, never cancelled).
- Internal deadline expiry degrades instead of cancelling: tier resolution
  falls back to the active model, root/leaf calls fall back deterministically,
  native replay is skipped with a recorded reason, and the DAG write loop
  checks only user cancellation (writes are fast file ops).
- Deadline aborts persist status and return `{ cancel: true }` well inside
  the wall; user-cancel semantics are unchanged.

## Regression evidence (test-first)

`test/controller.test.ts`:

- A never-settling, signal-ignoring `nativeCompact` previously hung the
  handler past its internal deadline (test timed out); now the handler
  resolves within seconds with `lastOutcome success`, native replay recorded
  as failed with "internal deadline reached", and `lastDeadlineStage`
  `native-replay`.
- A hanging plugin-settings loader previously stalled `readConfig` before any
  deadline existed; now the run completes with default config within the
  prelude bound.

`test/controller-deadline.test.ts` (frozen wall-clock contract, no fake
clocks): the deadline-reserve-exhausted run now records the root stage as the
first deadline-affected stage (root condensation aborts at the internal
deadline instead of running past it), native replay is skipped, and a
compaction result is still produced.

## Final state

```text
$ bun run typecheck      # clean
$ bun test               # 224 pass, 3 skip, 0 fail (1107 expects)
$ LCM_LIVE_INTEGRATION=1 bun test test/native-replay.integration.test.ts
                         # 5/5 pass, model-quality summaries
                         # (lastSummaryQuality model, zero fallbacks),
                         # native replay preserved
```

Live runs still finish with the internal budget intact: full model quality
and `lastNativeReplayStatus preserved` are asserted by the integration
suite and pass.

# Verification log — Concurrent provider-native replay (2026-08-01, GAP-013)

Package: `omp-lcm-inspired-compaction` 0.2.4 (unreleased delta; OMP 17.2.3)

## Change

Provider-native replay previously ran only after the textual LCM path
completed (leaf summaries, DAG condensation), so eligible compactions paid
both latencies serially. It now starts immediately after raw capture and
runs concurrently with the leaf/root stages under the same absolute internal
deadline and cancellation signal (`src/controller.ts` `runNativeReplay`;
the branch is started before tier resolution and awaited only after a
successful DAG build). The textual LCM result stays authoritative: replay
failure or internal-deadline expiry is fail-isolated, records
`lastNativeReplayStatus`/`lastNativeReplayError`/`lastDeadlineStage`, and
never invalidates a completed textual compaction. The pre-start reserve
guard remains: if capture itself consumed the deadline budget, replay is
skipped with the recorded reason instead of starting an already-expired call.

## Regression evidence (test-first)

`test/controller.test.ts`:

- New ordering test: the leaf summary waits on a promise barrier only the
  replay request resolves, so a sequential implementation deadlocks and
  times out. The replay request is asserted to precede the leaf summary, and
  the merged preserve data carries `openaiRemoteCompaction` with status
  `preserved`.
- The existing never-settling `nativeCompact` test still passes: the
  concurrently started replay is bounded by the total deadline and the run
  completes successfully with replay recorded as failed ("internal deadline
  reached").

`test/controller-deadline.test.ts` (frozen wall-clock contract, no fake
clocks): the reserve-guard test now consumes the deadline budget inside
capture (1.25 s of the 1.4 s injected budget), asserting the remote call is
never made, replay status is `failed` with "internal deadline reached", and
`lastDeadlineStage` is `native-replay`. The former "skip when the leaf/root
stages exhausted the reserve" test was replaced: with concurrent scheduling
that scenario no longer skips — replay starts at handler start and is
bounded by the total deadline instead.

## Final state

```text
$ bun run typecheck      # clean
$ bun test               # 225 pass, 3 skip, 0 fail (1112 expects)
$ bunx biome check src/controller.ts test/controller.test.ts \
    test/controller-deadline.test.ts
                         # clean apart from pre-existing legacy `any` sites
                         # present on HEAD
```

Wall-time latency of an eligible compaction is now approximately
`max(leaf/DAG, native replay)` instead of `leaf/DAG + native replay`;
deferred compaction execution (GAP-017) still requires public OMP lifecycle
APIs and remains out of scope.
