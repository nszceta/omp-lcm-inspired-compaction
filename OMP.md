# OMP Extension Boundary — Problems and Future GitHub Issue

Status: draft (2026-08-01). This document records the Oh My Pi (OMP) platform
limitations that constrain this plugin — and any lossless/archival compaction
extension — plus a GitHub issue template requesting the public APIs that would
remove them. Each limitation maps to a disposition in `GAPS.txt`
(GAP-011/012/015/017/018/019/020/023/034). Targets the OMP 17.2.3 package
line.

## 1. The problem

### 1.1 Compaction is synchronous and deadline-walled

OMP's extension runner aborts `session_before_compact` handlers after a fixed
30 000 ms wall and falls back to built-in compaction. A complete custom
compaction result must therefore be produced inside one synchronous handler
call: raw capture, leaf summarization, DAG construction, artifact writes,
provider-native replay, and rendering all compete for that budget. This
plugin has closed GAP-034 by bounding the full handler internally, but the OMP
wall remains the platform constraint that requires that mitigation.

Observed consequences:

- Under deadline pressure, the plugin may deliberately degrade quality:
  model summaries are replaced by bounded deterministic excerpts
  (`lastSummaryQuality: "deterministic-fallback"`, GAP-015), native replay is
  skipped, and snapcompact rendering degrades to context-full roots. The
  archival graph stays lossless, but the active context carries a worse
  summary than the provider could produce given time.
- Before the GAP-034 mitigation, a slow remote call inside the hook ran the
  handler into the wall: field incident 2026-08-01 (`Extension handler timed
  out after 30000ms`), with no persisted status and orphaned artifacts. The
  plugin now applies a prelude deadline plus an absolute 24 s (max 27 s)
  handler deadline, persists status, and degrades before the OMP wall. This is
  a plugin-side workaround, not a platform fix: the model loop still blocks
  for the full duration of every compaction.
- The 30 s budget is fixed and cannot be raised by the extension
  (`handlerDeadlineMs` is clamped below it).

### 1.2 Compaction work cannot outlive the handler wall — and must not precede it

The conversation prefix is the session's most valuable cache: every main
request re-touches it, and provider caches are TTL-based with capacity
behavior that is provider-internal. The prefix is also doomed the moment the
boundary fires — the installed compaction rewrites it, so no later request
uses it. The compaction event is therefore the *cache-safe zone*: summary LLM
calls that land there churn only a cache that is invalidated anyway, and the
burst's batch excerpts are one-shot inputs whose cache entries are never read
again. Moving those calls earlier in the session (per-turn background
summarization) trades that free churn for live-cache pressure: each call
writes fresh entries beside the prefix the next main request depends on, can
push it out on capacity-bounded caches (forcing a full-price re-read), and
fragments leaves into one-to-two-turn batches. The cache-optimal schedule is
all summaries at the boundary — but the 30 s handler wall cannot fit the
burst for large sessions, and no public API lets `session_before_compact`
return a pending job that OMP completes and installs later (GAP-017). The
plugin must therefore degrade or churn.

### 1.3 No atomic multi-artifact transactions

A compaction installs many artifacts (raw JSONL chunks, leaf nodes, parent
nodes) plus a preserve-state handoff. The extension boundary offers
one-artifact-at-a-time writes with no transaction scope: a failure after some
writes leaves unreachable orphan artifacts and no installed preserve state
(GAP-012). The plugin mitigates by deferring all writes until the DAG phase
and writing each raw artifact immediately before its node, but a mid-loop
failure can still leak earlier artifacts. There is no public commit/rollback.

### 1.4 No artifact deletion / retention API

Artifacts live for the session lifetime. The extension can enumerate
(`listFiles`) and count orphans (`lastOrphanArtifactCount`) but cannot delete
anything (GAP-023). Consequences: no garbage collection of unreachable
artifacts, no retention policy, unbounded disk growth in long or failure-prone
sessions, and no secure deletion of sensitive archived content (GAP-011).

### 1.5 Handoff and shake are invisible to extensions

Handoff and shake execute outside (or before) the ordinary custom-result
path, and the extension cannot inject archival source automatically before a
handoff (GAP-018). Users on those strategies receive no LCM archival and no
provider-native replay continuity.

### 1.6 Artifact IDs are not globally unique

`artifact://<id>` is session-scoped: an ID copied between sessions resolves to
unrelated content or nothing (GAP-020). External indexes cannot treat an
artifact reference as a stable global identity, and cross-session retrieval
instructions in preserved summaries are fragile.

### 1.7 The resolved compaction strategy is hidden

`renderer: auto` must guess the strategy from public fields (strategy,
custom-instruction presence, model vision support). Internal OMP guidance
overrides are not exposed, so auto-selection can diverge from OMP's actual
decision in edge cases (GAP-019).

## 2. Future GitHub issue — draft

File against [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi).
Follow-up issues can be split per item; this draft is the umbrella.

---

**Title:** Expose async compaction preparation, artifact transactions, and
retention APIs to extensions

**Labels:** `extension-api`, `compaction`, `api-proposal`, `needs-design`

### Summary

Extensions that implement their own compaction (e.g. lossless/archival
"LCM"-style plugins) are forced to do all work synchronously inside
`session_before_compact` under a fixed 30 s handler wall, with one-artifact-
at-a-time writes, no deletion API, and no visibility into handoff/shake or the
resolved strategy. This proposal adds public APIs so a compaction extension
can complete compaction work outside the synchronous handler wall (deferred
execution), install results atomically, and manage retention.

### Motivation

The `omp-lcm-inspired-compaction` plugin (marketplace `nszceta-lcm`) replaces
built-in compaction with exact archival + hierarchical summaries +
provider-native replay. Its production behavior is bounded by the platform
surface, not by its own design:

- Compaction latency remains fully on the model-loop critical path. The
  installed internal deadline may deliberately degrade quality (deterministic
  fallbacks, replay skipped) to avoid OMP's 30 s wall
  (`handlerDeadlineMs` is clamped below it).
- Before that mitigation, a field incident (2026-08-01) hit the 30 s wall,
  losing the whole run's status and orphaning its artifacts.
- Multi-generation sessions accumulate unreachable artifacts with no GC or
  retention possible from the extension boundary.
- Handoff/shake users get no archival; `renderer: auto` can diverge from
  OMP's internal decision.

### Current behavior

- `session_before_compact` is the only compaction hook; handlers are aborted
  after a fixed 30 000 ms.
- Artifact writes are one call per artifact (`saveArtifact`); no batch
  atomicity, no commit/rollback.
- No artifact deletion API (enumeration exists via `listFiles`).
- No handoff/shake lifecycle hooks and no source-injection contract.
- Artifact IDs are session-scoped numeric strings.
- The resolved compaction action (context-full/snapcompact/handoff/shake) is
  not exposed to extensions.

### Proposed API surface

Names are suggested shapes; exact signatures are subject to OMP's API review.

**A. Deferred compaction execution**

All DAG summary calls are triggered by the compaction event — the cache-safe
zone — never by per-turn ingestion:

- `session_before_compact` stays the single trigger. It decides the boundary
  synchronously (discard set known) and returns a *pending* compaction instead
  of working inline under the 30 s handler wall; OMP completes the job as a
  supervised, session-owned task that outlives the handler, reusing the same
  machinery as its own auto-compaction controllers (cancel, deadline,
  visibility). The job runs capture/batch planning → leaf-summarization burst
  (pooled) → condensation → render → atomic install via proposal B.
- The model loop never blocks on the job longer than the user's own turn: the
  job runs while the user reads; if the user submits before it completes, the
  next request waits for the install (queue semantics, as when the handler
  runs long today). User cancel, session switch, or shutdown aborts the job
  and discards without install; a lost job (extension reload) falls back to
  OMP's built-in compaction for that boundary. A configurable job deadline
  (minutes, not seconds) bounds the wait with the same degradation ladder as
  today.
- Per-turn incremental summarization is rejected: every background summary
  call writes fresh cache entries beside the live conversation prefix — on
  capacity-bounded caches this can evict the prefix and force the next main
  request to re-read it at full price — and each batch excerpt is a one-shot
  input whose entry is never read again. It also fragments leaves into
  one-to-two-turn batches and adds condensation levels. Deferred execution
  hides the same latency (overlap with reading time) with none of the churn.
- Cache-neutral metadata (raw capture plan, chunk boundaries, batch planning)
  MAY be assembled per-turn in the background at zero cache cost — pure
  bookkeeping, no LLM calls, no context mutation — so the boundary starts with
  its plan ready. Artifact writes stay deferred to the install until proposal
  B's transaction API makes pre-writing orphan-safe.
- This is not "raise the 30 s wall": the handler still returns immediately;
  only the job is deferred. A soft-threshold prep event
  (`session_compaction_approaching`) remains rejected: it predicts nothing
  (context growth is bursty), relocates the same LLM burst, and adds platform
  surface for no benefit.

**B. Atomic compaction installation**

- A compaction-scoped API such as
  `sessionManager.commitCompaction({ artifacts, result })`, or a transaction
  handle whose `commit(result)` atomically writes the artifact batch *and*
  installs the returned compaction/preserve data.
- Requirement: if the handler fails or the transaction is rolled back, no new
  artifacts or preserve state are visible. After commit, every referenced
  artifact and its installed preserve root are visible together; no new
  unreachable artifacts are left behind.

**C. Artifact deletion / retention**

- `sessionManager.deleteArtifacts(ids, options?)` with a safety contract:
  deletion of artifacts reachable from installed preserve data (roots)
  requires an explicit `force` flag or is refused.
- At minimum, deletion of provably unreachable artifacts (orphan GC), enabling
  retention policies and secure deletion of sensitive content.

**D. Handoff/shake hooks + source injection**

- Public `session_before_handoff` / shake-region callbacks mirroring
  `session_before_compact`, plus a safe contract for injecting archival
  source automatically before handoff.

**E. Globally unique artifact references**

- Opaque globally unique artifact IDs, or a compound public reference
  (`<sessionId>/<artifactId>`) resolvable through a public API, so external
  indexes and preserved summaries can carry stable cross-session identity.

**F. Resolved strategy visibility**

- Include the resolved compaction action (and any internal guidance
  overrides) as a public field on the compaction preparation, so
  `renderer: auto`-style logic is deterministic.

### Acceptance criteria

1. An extension can produce a complete compaction result as a supervised job
   that starts at the boundary decision, outlives the 30 s handler wall, is
   never blocked on longer than the user's own turn, installs atomically when
   ready, and is cleanly discarded on cancel/stale — with all summary LLM
   calls confined to the compaction event (no session-time cache churn).
2. A multi-artifact compaction is all-or-nothing from the extension's view:
   failure before commit leaves zero new artifacts.
3. An extension can delete artifacts it has proven unreachable, with a
   documented safety contract protecting installed roots.
4. Handoff and shake events expose equivalent hooks to
   `session_before_compact`, and the resolved strategy is observable.
5. Artifact references resolve deterministically across sessions.

### Alternatives considered

- **Raise/remove the 30 s handler wall** — rejected: unbounded synchronous
  blocking is worse for the user; the wall is a backstop, not a scheduling
  mechanism. A configurable timeout is a partial mitigation only.
- **Extensions keep degrading inside the wall** — current state; bounded
  quality loss and critical-path latency remain permanent.
- **OMP performs archival itself** — out of scope; the ask is extension
  surface, not built-in behavior.

### References

- Plugin: `github.com/nszceta/omp-lcm-inspired-compaction`
  - `GAPS.txt` — GAP-012 (transactions), GAP-017 (deferred compaction execution),
    GAP-018 (handoff/shake), GAP-019 (resolved strategy), GAP-020 (global
    IDs), GAP-023 (retention/GC), GAP-034 (30 s wall).
  - `OMP.md` (this file) — problem statement.
- Field incident: `Extension handler timed out after 30000ms`
  (session_before_compact, 2026-08-01) — recorded in `VERIFICATION.md`.

---
