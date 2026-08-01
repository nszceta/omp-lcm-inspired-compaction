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

## Known accepted limitations recorded in this pass

- `lcm_grep` patterns are agent-supplied tool arguments (semi-trusted,
  grep-tool norm); catastrophic-backtracking regexes are the caller's
  responsibility (GAP-021 disposition).
- The live opt-in smoke (real OMP `/compact` against configured credentials)
  remains environment-gated; the deterministic wall-clock regression is the
  authoritative fallback evidence for the 30-second budget claim.
