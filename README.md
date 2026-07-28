# omp-lcm-inspired-compaction

Artifact-backed hierarchical compaction for Oh My Pi (OMP). The plugin keeps exact discarded session entries in session-scoped artifacts, builds bounded immutable summary roots, and renders those roots through OMP context-full or public snapcompact APIs.

## Install and enable

For automatic marketplace updates, add this repository as a marketplace and
install the named plugin into the user scope:

```sh
omp plugin marketplace add https://github.com/nszceta/omp-lcm-inspired-compaction
omp plugin install omp-lcm-inspired-compaction@nszceta --scope user
```

The marketplace manifest is `.omp-plugin/marketplace.json`. The `nszceta`
marketplace name comes from that manifest; verify it with:

```sh
omp plugin marketplace list
omp plugin list
```

To receive new tagged releases, refresh the marketplace metadata and upgrade
the installed plugin:

```sh
omp plugin marketplace update nszceta
omp plugin upgrade omp-lcm-inspired-compaction@nszceta --scope user
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
- `/lcm status` shows the last renderer, generation, root count, remote interception flag, and bounded outcome/error status.
- Tab completion after `/lcm ` suggests `help`, `status`, and `renderer`; after `/lcm renderer ` it suggests all supported renderers.
- `/lcm renderer auto`
- `/lcm renderer context-full`
- `/lcm renderer snapcompact`

## Retrieval

Each discarded source chunk is stored as exact JSONL in an `lcm-raw` session artifact. Immutable `lcm-node` artifacts contain leaf or parent summaries and their provenance. Active context contains only bounded root summaries and deterministic links:

```text
Expand node: artifact://17
```

Use `lcm_expand` for node structure, `read artifact://17` or a selector such as `read artifact://17:1-300` for exact source, and `grep "symbol" artifact://17` for exact search. Artifact IDs are numeric and scoped to the OMP session; never predict an ID.

## Rendering and remote behavior

Context-full returns a complete custom compaction result containing portable text roots and only the plugin preserve key. Snapcompact receives a synthetic message containing current roots, never the previous raw transcript/archive, and preserves the summary-only archive across context rebuilds. A second compaction creates parent nodes while retaining the original raw artifacts transitively.

Returning a complete result from `session_before_compact` bypasses OMP local, configured remote, and provider-native compaction paths. The status command marks remote-enabled context-full handling. If a model summary fails, the plugin converges to a deterministic bounded archival summary. If the event is aborted, the boundary is invalid, an artifact write fails, the model/key is missing, or an explicit snapcompact renderer lacks image support, the plugin notifies and returns `{ cancel: true }`; it never falls through to built-in compaction.

Summary calls use the active OMP model and its API key. Hosted model traffic may therefore occur for summaries; remote interception refers to OMP's built-in compaction path, not all network traffic.

## Limitations

The standalone extension cannot provide asynchronous soft-threshold compaction, atomic multi-artifact transactions, globally unique IDs across sessions, automatic pre-handoff injection, or shake-region callbacks. Partial artifact writes may orphan artifacts, but no node or preserve state is installed unless all referenced writes succeed.
