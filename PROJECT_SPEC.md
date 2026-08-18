# Memory Anchor Project Specification

## 1. Product purpose

Memory Anchor provides durable, local repository memory for coding agents. It
turns source code into routed architecture charts, preserves repository-specific
rules and decisions in reviewable Markdown, and keeps that memory current as
the working tree changes.

The product must work without a hosted retrieval service. All generated state
lives in the target repository and can be inspected, versioned, or regenerated
with the CLI.

## 2. Goals and non-goals

### Goals

- Give an agent a small, useful starting context for a large repository.
- Route the agent from a repository index to the chart closest to its task.
- Extract architecture-level symbols and repository relationships from source
  with Tree-sitter.
- Preserve durable rules, known issues, and technical decisions alongside
  generated charts.
- Refresh only affected charts after Git-visible source changes whenever the
  directory topology is still valid.
- Support Copilot, Claude Code, Codex CLI, CodeBuddy, OpenCode, and QoderCLI
  CN through each platform's supported configuration and lifecycle hooks.

### Non-goals

- Reproduce source files or every implementation detail in Markdown.
- Replace code review, tests, Git history, or agent-native context management.
- Resolve package dependencies or imports that cannot be mapped to a repository
  file.
- Preserve manual edits to generated chart files.

## 3. Repository artifacts

`anchor init` creates or updates the following shared repository memory:

| Artifact | Responsibility |
| --- | --- |
| `.memoryanchor/index.md` | Small routing index that identifies the root chart partitions. |
| `.memoryanchor/chart/**/chart.md` | Generated architecture charts, partitioned by directory topology. |
| `.memoryanchor/dirTree.json` | Persisted directory sizes, split states, and virtual chart-tree routes. |
| `.memoryanchor/dependencyGraph.json` | Persisted file-import candidate and function-level forward/reverse dependency edges for incremental chart refreshes. |
| `.memoryanchor/ballast.md` | Durable default and repository-specific implementation rules. |
| `.memoryanchor/manifest.md` | Module status, dependencies, known issues, and key decisions. |
| `AGENTS.md` | Managed instructions that tell supported agents how to traverse and use the memory. |

Charts are generated artifacts and must not be edited manually. `ballast.md` and
`manifest.md` are durable project memory and are intentionally maintained over
time.

## 4. Full initialization

### Input and output

The primary operation is:

```bash
anchor init
```

It scans supported source files, compiles a partitioned chart tree, writes the
routing index, ensures the shared memory documents exist, and configures all
supported agent integrations. Targeted `init-<agent>` commands configure one
agent integration, while `init-public` creates only the shared repository
memory and public instructions.

### Build stages

A full chart build has four observable stages:

1. **Parse** — Tree-sitter extracts file imports, architecture symbols, and
   per-symbol call names from every supported file.
2. **Dependency index** — imports and call names are resolved into a
   build-wide, symbol-level reverse registry, then persisted with paired
   function edges and unresolved file-import candidates in
   `.memoryanchor/dependencyGraph.json` after rendering succeeds.
3. **Partition sizing** — aggregate directory character counts establish the
   physical and virtual chart topology.
4. **Render** — chart-local file nodes are rendered to `chart.md` files and
   `.memoryanchor/index.md` is written.

The full build owns a temporary parse cache keyed by absolute path, so each
source file is parsed once even though parsing, reverse indexing, and rendering
need its extracted information. The cache contains serializable extracted data,
not source strings or Tree-sitter trees, and is released at the end of the
build.

## 5. Chart topology and routing

Directory size determines whether a directory is split:

| State transition | Aggregate source characters |
| --- | ---: |
| Split a non-split directory | More than 18,000 |
| Merge a split directory | Less than 14,000 |
| Retain current state | 14,000–18,000 |

The separate split and merge thresholds provide hysteresis and prevent topology
changes from oscillating around a single boundary.

For each branch below a split directory, Memory Anchor selects the first
non-split directory as a **recursive frontier** and emits one chart covering
its full subtree. It emits no charts below that frontier. Split ancestors that
own direct source files receive **shallow charts** for those direct files and
link to child charts. The index lists the first virtual chart layer; each chart
lists only its immediate child chart routes.

Agents must read the index first, then follow the closest route through Child
Charts. Each generated chart identifies its own workspace-relative path so its
scope is explicit.

## 6. Chart content contract

Each chart contains a directory skeleton followed by extracted architecture
symbols. The managed `AGENTS.md` documents the exact notation; its essential
contract is:

- `->` lists parseable repository files imported or referenced by a file.
- `<-` appears only on a referenced symbol and lists symbols that call or
  depend on it.
- `+` marks an exported symbol; `-` marks a default or internal symbol.
- Every symbol includes a source range formatted as `[Lstart-end]`.
- Exported functions retain explicit source-declared parameter and return type
  annotations. Internal functions omit signatures. Classes, interfaces, enums,
  and types keep their category labels.
- Source comments, package dependencies, and unresolved imports are omitted.

Forward file relationships resolve across all parseable repository files. Full
builds also attach project-wide reverse callers to the referenced symbol, even
when the caller lives in another chart. The persisted graph retains each
caller's forward target keys and the exact inverse reverse lists; resolvable
imports whose target symbol does not yet exist are retained as dormant forward
candidates so a later target addition is visible without scanning all callers.

## 7. Parser and performance requirements

Parsing uses a demand-lazy `worker_threads` pool. A worker owns one Tree-sitter
parser and caches loaded WASM language modules for reuse. The pool begins only
when parseable work exists and is capped at one fewer than the available CPU
count (minimum two workers). Worker creation is further bounded by current
queue demand.

Full initialization destroys the pool when it finishes. Incremental CLI work
keeps the pool available for reuse until the session-end flow releases it. A
worker that exits is removed; queued work can create a replacement only when
there is outstanding demand. Destroying the pool must await workers that are
still starting so no thread or handle remains unowned.

The CLI must report elapsed time for each build stage and detailed render
timings. A representative benchmark is maintained in [benchmark.md](benchmark.md).
It records one Next.js initialization on a MacBook Air M2: 24,602 source files,
3,108 chart partitions, and 13.33 seconds total elapsed time. This result is a
single-machine snapshot, not a performance guarantee.

## 8. Incremental refresh

Supported stop and session-end integrations identify Git-visible changed files
and call `updatePartitionedChartIncrementally`. The legacy
`updateChartIncrementally` API remains a compatibility alias.

Each deduplicated change batch follows one ordered pipeline:

1. **Incremental parse** — parse the changed files and one direct-file view
   for each changed physical directory.
2. **Dependency graph** — reconcile changed callers and importers through
   their persisted forward edges, update target declarations, and collect
   reverse-caller-dirty targets plus importers whose `->` path changed.
3. **Pre-render sizing** — render each changed directory's direct chart in
   memory to confirm the exact character delta used by full-build sizing.
4. **Topology** — propagate those deltas through physical ancestors, add or
   prune direct-file directory nodes, and rebuild virtual ownership/routes.
5. **Reparse and render** — reparse each changed owner, dirty target, dirty
   importer, and topology-boundary chart from disk, then render it using the
   updated global dependency registry.
6. **Persist** — commit the dependency graph and directory registry after the
   final chart render succeeds; refresh the index only when routing changes.

Incremental graph maintenance never performs a repository-wide traversal of
reverse edges. A changed or removed caller supplies every reverse mutation
through its own forward edge list; deleting a target also removes the matching
target entries from both persistent edge maps. A changed target is rebuilt in
its own Git-visible chart update. Relative imports retain candidate target
paths, so creating or deleting a code file refreshes only its unchanged
importers.
Missing or invalid graph state safely falls back to a full partitioned build.

Changes that cross a split or merge threshold rebuild only the affected
topology boundary and external parents whose Child Chart routes changed.
Direct-file additions and removals update the persisted physical tree locally;
only missing or invalid topology/dependency state safely falls back to a full
partitioned build. Batches deduplicate physical directories before
directory-scoped I/O and final chart owners before reparsing.

## 9. Agent integration requirements

At session start, the common context payload must provide, in order:

1. Index routing rules.
2. The root chart when one exists.
3. Ballast rules.
4. Manifest state and decisions.

Per-turn reinforcement is opt-in and controlled by
`.memoryanchor/prompt-hooks.json`. The file stores an `enabled` array of agent
IDs (`claude`, `codex`, `codebuddy`, `qodercn`, `copilot`, `opencode`, and
`hermes`); missing or empty configuration disables every UserPrompt hook. The
`anchor prompt-hook` command manages this selection, enabling the named
agents exactly or all agents when no names are supplied. Codex is supported
by the same opt-in policy and still has no session-level `SessionEnd` event.
OpenCode extends system context through
`experimental.chat.system.transform`; its optional per-turn reminder reads the
selection at runtime and mutates the outbound message copy through
`experimental.chat.messages.transform`, leaving the persisted user message
unchanged. The plugin resolves workspace state from the first supplied
`worktree`, `directory`, or process directory containing `.memoryanchor`; this
also anchors lifecycle commands when OpenCode reports a non-Git worktree.

Hermes Agent has no project-scoped hook config: shell hooks are registered in
the global `$HERMES_HOME/config.yaml` (default `~/.hermes/config.yaml`), so
they fire in every project the agent runs in and must no-op outside a Memory
Anchor workspace. Context injection uses `pre_llm_call` with a `{"context":
...}` JSON reply that Hermes appends to the user message, preserving the
system-prompt cache; the stop handler binds to `on_session_end` and the
session-end handler to `on_session_finalize`. Edits to the YAML config are
round-trip safe, preserving comments and user-owned hook entries, and an
invalid existing config aborts initialization instead of being overwritten.

Initialization is idempotent: it may repair or replace Memory Anchor-managed
configuration but must preserve user-owned hook entries and unrelated agent
configuration.

## 10. Supported languages

Bundled Tree-sitter WASM grammars cover C, C++, CSS, HTML, Go, Java,
JavaScript, JSON, Python, Ruby, Rust, Scala, Swift, TypeScript, and TSX.

## 11. Acceptance criteria

- `anchor init` creates a valid index, chart tree, directory registry, ballast,
  manifest, and configured integrations without duplicate managed hooks.
- Every generated chart follows the content contract and identifies its own
  path.
- The index and Child Chart routes reach the nearest valid chart partition.
- A full build parses each supported file no more than once within its
  build-scoped cache.
- Incremental updates refresh the correct owning chart and only rebuild broader
  topology when size or direct-file ownership changes require it.
- Initialization persists paired function edges and relative file-import
  candidates; incremental caller additions/removals, target changes, and
  target-file creation/deletion rerender the affected target or importer charts.
- Full-build and incremental worker-pool lifecycles do not leave active worker
  threads after their respective cleanup boundary.
- `npm test` passes, including regression coverage for parsing, topology,
  generated documents, configuration merging, and worker-pool cleanup.

## 12. Known limitations

- Git-visible paths drive automatic incremental updates; non-visible changes
  may require a fresh `anchor init`.
- An oversized leaf directory has no smaller directory partition; file-level
  partitioning is future work.
- Generated charts do not preserve manual edits.
