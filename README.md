# omp-lcm-inspired-compaction

Artifact-backed hierarchical compaction for Oh My Pi (OMP). The plugin keeps exact discarded session entries in session-scoped artifacts, builds bounded immutable summary roots, and renders those roots through OMP context-full or public snapcompact APIs.

## How it works

LCM is lossless because it separates **what stays in the active context** from
**what remains recoverable**. Compaction produces bounded summaries for the
active context, but every discarded session entry is also stored exactly in a
session-scoped `lcm-raw` artifact. Immutable summary nodes record provenance
and links to those raw artifacts.

The first compaction creates level-0 leaf nodes. Each later compaction loads the
previous roots, adds new level-0 leaves, and condenses them into immutable
parent nodes whenever the active root set exceeds four roots or the summary
token budget. Parent nodes link to their children, and children link
transitively to the exact raw source, so history remains reachable without
copying the transcript into every new summary:

```text
generation 1:  leaf A ── raw A     leaf B ── raw B

generation 2:  parent C
                ├── leaf A ── raw A
                └── leaf B ── raw B
              leaf D ── raw D

generation 3:  parent E
                ├── parent C
                └── leaf D
```

Only a bounded set of current roots is carried forward in OMP's
`preserveData`; older nodes and raw artifacts remain available through their
links. This gives OMP a small, useful context while retaining exact historical
source for later retrieval with `lcm_expand`, `read artifact://ID`, or
`grep` against an artifact URI. The summaries are intentionally lossy views
for context efficiency; the archival graph is lossless because the original
discarded entries are preserved verbatim.

## Install and enable

For automatic marketplace updates, add this repository as a marketplace and
install the named plugin into the user scope:

```sh
omp plugin marketplace add https://github.com/nszceta/omp-lcm-inspired-compaction
omp plugin install omp-lcm-inspired-compaction@nszceta-lcm --scope user
```

The marketplace manifest is `.omp-plugin/marketplace.json`. The `nszceta-lcm`
marketplace name keeps this plugin separate from other `nszceta` marketplaces;
verify it with:

```sh
omp plugin marketplace list
omp plugin list
```

To receive new tagged releases, refresh the marketplace metadata and upgrade
the installed plugin:

```sh
omp plugin marketplace update nszceta-lcm
omp plugin upgrade omp-lcm-inspired-compaction@nszceta-lcm --scope user
```

To upgrade every marketplace plugin instead:

```sh
omp plugin marketplace update
omp plugin upgrade
```

`omp plugin install ./path/to/this/repository` is useful for local development
but creates a local link and does not track marketplace releases. Likewise,
installing a raw GitHub URL is a direct install; use the marketplace commands
above for update tracking. Restart OMP, or reload extensions, after installing
or upgrading.

The package supports OMP 17.1.8 and uses only published OMP extension APIs.

The `renderer` setting accepts `auto`, `context-full`, or `snapcompact`.
`auto` selects snapcompact only for a snapcompact preparation with a
vision-capable model and no custom instructions; otherwise it uses context-full.
Set an explicit renderer when deterministic behavior is required. Automatic
LCM is intended for OMP `context-full` and `snapcompact`; handoff, shake, and
off remain OMP-controlled.

## Commands

- `/lcm` or `/lcm help` displays command help in the OMP UI.
- `/lcm version` shows the plugin version currently loaded by OMP.
- `/lcm status` shows the last renderer, generation, roots, summary quality,
  provider-native replay status, bounded result metadata, and outcome/error
  status.
- `/lcm dump` prints those diagnostics and traverses the bounded artifact DAG
  with structural, single-line summary previews.
- Tab completion after `/lcm ` suggests `help`, `status`, `dump`, `version`,
  and `renderer`; after `/lcm renderer ` it suggests all supported renderers.
- `/lcm renderer auto`
- `/lcm renderer context-full`
- `/lcm renderer snapcompact`

## Retrieval

Each discarded source chunk is stored as exact JSONL in an `lcm-raw` session artifact. Immutable `lcm-node` artifacts contain leaf or parent summaries and their provenance. Active context contains only bounded root summaries and deterministic links:

```text
Expand node: artifact://17
```
Use the registered `lcm_expand` tool for node structure and optional raw previews. Use `read artifact://17` or a selector such as `read artifact://17:1-300` for exact source, and `grep "symbol" artifact://17` for exact search. Root artifact IDs are shown by `/lcm dump`; IDs are numeric and scoped to the OMP session, so never predict an ID.

## Rendering and remote behavior

Context-full returns a complete custom compaction result containing portable
text roots and LCM preserve state. Snapcompact receives a synthetic message
containing current roots, never the previous raw transcript/archive, and
preserves the summary-only archive across context rebuilds. A second compaction
creates parent nodes while retaining the original raw artifacts transitively.

Returning a complete result from `session_before_compact` bypasses OMP's
built-in compaction call. For eligible OpenAI Responses models with remote
compaction enabled, the plugin delegates replay generation to OMP's published
compaction orchestrator. OMP uses streaming V2 when the active model advertises
it and the setting permits it, including retained-message budgeting and the
session's active thinking effort; otherwise OMP uses its eligible V1 path. The
plugin merges the resulting `openaiRemoteCompaction` state with
`ompLcmArtifactsV1`.

A later compaction seeds a fresh remote request only when the preserved replay
lineage matches the active provider, effective model ID, Responses API variant
and V1/V2 mechanism, normalized endpoint, and non-secret credential
fingerprint. OAuth lineage uses stable account/organization/credential
metadata, so access-token refresh does not break continuity. Legacy or
mismatched lineage, disabled/ineligible models, missing credentials, empty
input, and remote failure never install stale replay data; textual LCM
continuity remains usable while a fresh native lineage starts.

Exact raw artifacts retain opaque `thinkingSignature`, `encrypted_content`, and
provider payload fields. The summary projection omits those opaque values so
they consume no summarization tokens. `/lcm status` and `/lcm dump` report
native replay status, provider, item count, whether prior history was seeded,
and a bounded error. Diagnostics call the bypass
`builtInRemoteContextFullIntercepted`; it describes interception of OMP's
built-in branch, not whether the plugin's explicit native replay request ran.

If a model summary fails, the plugin converges to a deterministic bounded
archival summary. If the event is aborted, the boundary is invalid, an artifact
write fails, the model/key required for textual summarization is missing, or an
explicit snapcompact renderer lacks image support, the plugin notifies and
returns `{ cancel: true }`; it never falls through to built-in compaction.

## Live provider replay verification

Run the opt-in live integration suite against configured OpenAI-Codex
credentials with:

```text
bun run test:integration
```

The suite fixes both requested models at low effort. Its first test compacts
with `gpt-5.3-codex-spark`, switches to `gpt-5.6-luna`, and proves both use
OMP's streaming V2 mechanism while the Spark encrypted lineage is not seeded
into Luna and textual LCM advances to generation 2. Its second test performs
two Spark compactions and requires encrypted replacement history on both
rounds, LCM generations 1 then 2, and `lastNativeReplaySeeded: true` on the
compatible second round. Provider responses and remote compaction are live;
assertions use persisted structural state rather than generated prose.

On 2026-07-28, package `0.1.6` running on OMP `17.1.8` completed a live
end-to-end canary with the connected
`openai-codex/gpt-5.3-codex-spark` provider. No transport or provider response
was mocked.

**Conclusion:** encrypted provider-native remote compaction is successfully
integrated with LCM for the tested OpenAI-Codex path. The integration does more
than store encrypted fields: one compaction persisted the provider replacement
history alongside the textual LCM DAG, a new OMP process reconstructed that
history, and the provider accepted a real continuation request.

The pre-compaction conversation contained model reasoning plus real `read`,
`bash`, and `grep` tool calls. Its early canary values were nonce
`cedar-orbit-7319`, codename `Silver Heron`, batch size `17`, and the derived
result `323`. Two large tool-result turns then raised context use to 58.5%, and
manual compaction reduced it to 15.3%.

The live process reported:

```json
{
  "lastGeneration": 1,
  "lastNativeReplayStatus": "preserved",
  "lastNativeReplayProvider": "openai-codex",
  "lastNativeReplayItemCount": 6,
  "lastNativeReplaySeeded": false,
  "lastOutcome": "success"
}
```

The persisted compaction entry at `2026-07-28T19:24:45.511Z` contained both
`ompLcmArtifactsV1` and `openaiRemoteCompaction`. The latter identified
`openai-codex` and held six replacement-history items. This establishes that a
real remote-compaction response, rather than only the textual LCM result, was
installed in the saved session.

The first OMP process was then exited. A new process resumed the saved session
by ID, forcing OMP to rebuild context from the persisted compaction entry. The
next prompt prohibited tools and file reads and requested the values available
before compaction. The real provider continuation completed with
`stopReason: "stop"`, used zero tool calls, and returned:

```text
CANARY_REPLAY_ACCEPTED cedar-orbit-7319 Silver Heron 17 323
```

These observations prove the required chain for the connected provider: the
live compaction endpoint returned provider-native state, OMP persisted and
reloaded that state in a new process, the provider accepted the reconstructed
continuation request, and semantic continuity survived compaction. Textual LCM
roots remain in the same request as the provider-native state, so this canary
does not claim that native replay was the exclusive source of the recalled
words.

The canary scope is specifically the existing authenticated OpenAI-Codex
connection. A direct API-key-authenticated `openai` provider was not configured
or exercised, so this evidence must not be generalized to that credential and
endpoint path.

## Limitations

The standalone extension cannot provide asynchronous soft-threshold compaction, atomic multi-artifact transactions, globally unique IDs across sessions, automatic pre-handoff injection, or shake-region callbacks. Partial artifact writes may orphan artifacts, but no node or preserve state is installed unless all referenced writes succeed.
