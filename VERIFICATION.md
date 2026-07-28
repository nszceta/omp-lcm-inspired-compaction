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
