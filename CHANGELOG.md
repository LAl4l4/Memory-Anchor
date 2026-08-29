## Update log

- `2026/08/30`:
    - [Changed] Renamed persistent memory files to `guardrails.md` and `project-state.md`; session context, CLI status, generated guidance, and OpenCode injection now use the clearer names. `anchor init` migrates legacy `ballast.md` and `manifest.md` files when their canonical replacements are absent.

- `2026/08/29`:
    - [Added] Session-start context now enforces advisory memory-size limits: guardrails above 5 KiB or the project-state `Module Status` section above 8 KiB triggers an explicit compaction mission for the model. The complete memory remains injected, and both native hooks and the OpenCode plugin request semantic merging instead of truncating rules or module records.
    - [Changed] Repository guidance now requires agents to merge new lessons into existing guardrails first and add a new line only for a distinct, durable constraint.
    - [Improved] Simplify generated chart navigation and presentation: `index.md` is now a compact entry-chart router; each chart exposes its path, scope, traversal mode, file count, and parent; directory skeletons no longer duplicate dependency edges; empty symbol blocks are omitted; and child-chart routes use compact labels. Incremental topology reconciliation now rerenders charts whose displayed parent changes, keeping full and incremental output identical.
    - [Fixed] Worker-pool shutdown now retains Worker instances that are still waiting for their ready handshake and terminates them before awaiting startup promises. Workers remain referenced during startup and active tasks but are unreferenced while idle, so a stalled initialization can be destroyed immediately and an abandoned idle pool can no longer keep Jest or a CLI process alive.
    - [Changed] Migrated Jest test suites and shared test helpers from JavaScript to TypeScript using the standard `ts-jest` transformer. All tests now pass strict TypeScript checking before execution; JavaScript parser fixtures remain unchanged.

- `2026/08/19`:
    - [Fixed] Incremental refresh now persists observed `??` file paths in `.memoryanchor/untracked-files.json`, checks those paths at each Stop/session-end capture, and supplies a synthetic deletion when one disappears before entering Git's index. It removes a path from the watch set once `git ls-files` reports it as tracked, so the persistent dependency graph no longer retains stale reverse callers from deleted untracked files. See [Incremental Untracked-File Deletion Fix](./fixes/INCREMENTAL_UNTRACKED_DELETION_LIMITATION.md).
    - find incremental update will always fallback in all agent and only in next.js repo, need further check. I need print logs in .memoryanchor/ when error cause.
    - [Added] `anchor debug` persists an opt-in workspace debug setting and appends CLI, chart-build, lifecycle, and incremental-fallback diagnostics to `.memoryanchor/debug.log`; `anchor debug --off` stops further writes without deleting the evidence.
    - [Improved] Debug hook diagnostics now record the triggering agent, lifecycle event, resolved working directory, and success/failure result for native integrations and OpenCode plugin callbacks.
    - [Fixed] Correct OpenCode lifecycle semantics: `session.deleted` denotes removal of a stored conversation, not CLI shutdown, and now has no Memory Anchor side effect. Because the stable plugin API has no application-finalization event, `session.idle` now follows Codex's `Stop` fallback by invoking `memoryanchor-opencode-post`, which runs session-end maintenance, incremental refresh, and pool cleanup after work completes. OpenCode post-hook diagnostics now report `session.idle`, with initializer and real-runtime regression coverage.
    - [Fixed] OpenCode now resolves the active workspace from the first supplied context path containing `.memoryanchor` and runs lifecycle hooks from that root. This prevents non-Git or nested OpenCode sessions from reading the wrong state and repeatedly falling back.
    - [Fixed] Incremental dependency-graph reconciliation now removes deleted target symbols from both reverse and forward edges, keeping deleted providers and their importers consistent with a full rebuild.
    - Keep full builds source-driven: partition topology is rebuilt from the current workspace without reusing the previous directory registry. Add behavior-consistency coverage for file, directory, provider, virtual-branch, and frontier deletions with fixed test thresholds.

- `2026/08/18`:
    - Add Hermes Agent hook adaptation. Hermes registers shell hooks in the global `$HERMES_HOME/config.yaml` (`yaml` round-trip editing preserves comments and user entries), so the integration extends `hookProtocol.ts` with the `snake-case` event style, `stdout-json-context` injection, and `yaml-hook-array` config shape. Context flows through `pre_llm_call` as `{"context": ...}` (appended to the user message, keeping the system-prompt cache intact), the stop handler binds to `on_session_end` and the session-end handler to `on_session_finalize`, and every Hermes hook is a silent no-op outside Memory Anchor workspaces because the global registration fires in all projects. `anchor prompt-hook` toggles the optional `pre_llm_call` prompt reminder and honors `HERMES_HOME`; init refuses to edit an invalid existing config.
    - Move OpenCode's optional per-turn chart reminder from `chat.message` to `experimental.chat.messages.transform`, so it is added only to the outbound message copy and does not modify the persisted user message. Keep the core Memory Anchor payload on `experimental.chat.system.transform`.

- `2026/08/17`:
    - [Fixed] Stop/session-end incremental updates now expand untracked directories to file paths with `git status --porcelain --untracked-files=all`. New child files therefore enter topology creation instead of being treated as parent-directory changes, so shallow split charts receive their new child chart and route. Regression coverage now includes several new child directories in one batch, hook-level file expansion, and full-vs-incremental artifact comparisons.
    - find that post and stop hook will not trigger in all agent, need further check.
    - Make UserPrompt reminders opt-in through `anchor prompt-hook [agents...]`, with no agent list enabling all six supported integrations and `--off` disabling selected reminders. Codex now has a supported opt-in `UserPromptSubmit` wrapper.
    - Benchmark the current incremental pipeline on Next.js: a 24,603-file full build takes 13.21 s; steady-state incremental updates take 488–601 ms for one affected chart and 1.30 s when a caller change refreshes two charts.
    - Strip inherited `--input-type` flags from parser, reverse-dependency, and chart worker `execArgv` values. Node accepts that flag only for eval/print/stdin, so file-based workers otherwise exit with `ERR_INPUT_TYPE_NOT_ALLOWED` and can trigger repeated pool recovery attempts. Add a child-process regression test for `node --input-type=module -e ...`.
    - Persist a versioned `.memoryanchor/dependencyGraph.json` after full initialization with function-level forward edges, inverse reverse edges, caller metadata, target declaration offsets, and parseable file paths. Incremental chart rebuilds reconcile the rebuilt chart's forward edges only, mark changed target/importer charts dirty, and rerender them without a repository-wide reverse-edge scan. Missing or invalid graph state falls back to a full partitioned build.
    - Refactor `updatePersistentDependencyGraph` into focused state collection, snapshot, reconciliation, and dirty-result helpers. Add explicit full-build and incremental-reconciliation separators in `persistentDependencyGraph.ts`; the full Jest suite remains green with 22 suites and 177 tests.
    - Split oversized chart tests into focused suites for directory-tree structure, dependency graphs, partition rendering, incremental updates, chart rendering, parser pools, and incremental builds. Share fixture/setup helpers and move full-vs-incremental artifact checks into the dedicated `tests/behavior-consistency/` partition, separate from function-level correctness tests.

- `2026/08/02`:
    - Exclude Codex from the per-submission reminder hook. GPT-5.6 follows repository and session-start instructions reliably enough that repeated per-turn injection is unnecessary; `init-codex` now removes the legacy Memory Anchor `UserPromptSubmit` command while preserving user-owned prompt hooks.

- `2026/07/31`:
    - dependencyGraph might not safe to parallel call, need further check.
    - Fuck, dep worker will call collectGlobalReverseDependencies() as many as core - 1 times, it do same work.
    - Reorganize `src/chartBuild/` from flat domain folders into pipeline-stage folders, each exposing one `run*` interface composed by an external orchestrator. `buildChart.ts` runs `parse/runParse` → `reverse/runReverseDependency` → `partition/runPartitioner.partition` → `render/runRender` with explicit data hand-off and no cross-stage coupling. `buildChartFull` and the full-build debug entries live with that orchestrator, while the compatibility incremental entry points live in `incremental.ts`. `chartPartitioner/` is absorbed into the `partition/` stage; the old chartBuildHelper-derived code lands in `parse/`, `reverse/`, `render/`, `shared/`. Worker pools keep their paired worker files in the same stage so `import.meta.url`-based worker paths stay valid. Updated src/tests/Makefile paths, PROJECT_SPEC.md, and regenerated the memory-anchor charts.
    - Add time clock to show performance.
    - Fix a severe Stage 4 partition-render performance regression on large repositories. Full rendering now runs on the main heap, reusing the project-wide reverse dependency registry and parsed file-node cache instead of structured-cloning them into render workers per chart.
    - Build the repository dependency-path Set once and adapt it to each chart with a constant-cost path-prefix lookup. This removes the repeated full-repository `path.relative` conversion previously performed for every partition chart.
    - Deep-copy the mutable nested fields of chart-local FileNodes before rendering, preserving build-cache isolation without worker structured cloning. See [Render Performance Regression Fix](./optimization-fixes/RENDER_PERFORMANCE_FIX.md).

- `2026/07/26`:
    - Enrich generated chart nodes from the existing single Tree-sitter traversal: charts now show repository-wide file dependencies (`->`), chart-local imported-symbol reverse callers (`<-`), export/internal visibility (`+` / `-`), source line ranges, and source-declared types for exported functions. The relationship legend is injected once through generated `AGENTS.md`; source comment summaries and unresolved external package dependencies are deliberately omitted.
    - Resolve file-heading `->` edges against every parseable repository file, including cross-chart targets, because they serve as low-cost module-coupling navigation. Keep `<-` edges chart-local and attach them only to the referenced function or symbol: file-level reverse edges blur which declaration is used, create misleading impact sets for multi-symbol files, and add unnecessary work and output during incremental refreshes.
    - Raise partition hysteresis thresholds to `{ splitAt: 18000, mergeAt: 14000 }`, reducing chart fragmentation while retaining a 4,000-character merge buffer.
    - Replace repeated symbol/call scans in function-level dependency inversion with worker-attributed forward edges and collision-safe, hash-indexed reverse writes. See [Dependency Graph Optimization](./optimization-fixes/DEPENDENCY_GRAPH_OPTIMIZATION.md).
    - Add a project-wide reverse-call registry for full builds. Its target indexing, import/call inversion, caller de-duplication, and chart annotation are linear in symbols plus resolved call edges; deterministic file/directory ordering remains the intentional `O(F log F)` part of chart generation.

- `2026/07/24`:
    - Add non-blocking per-user-prompt chart reminders for Claude, Codex, CodeBuddy, Qoder, Copilot, and OpenCode. OpenCode's plugin is now type-checked and compiled from TypeScript before init copies the generated JavaScript into the workspace.

- `2026/07/24`:
    - Add an end-to-end hook trigger test that starts an OpenCode agent with real input, submits a command, exits with Ctrl+C, and verifies that the hook actually ran.

- `2026/07/21`:
    - Observed that constraint by agents.md is not strong enough, low level model will glob and grep without read the chart.

- `2026/07/21`:
    - Replace directory-per-chart expansion with a virtual threshold-frontier chart tree. Small projects flatten into one root chart; split ancestors with direct files own shallow charts that link to the next frontier chart.
    - Persist virtual chart parent/children paths, expose every chart's path, always inject index routing rules, and additionally inject the root chart when it exists.
    - Remove repeated per-file glob scans, keep split/merge rebuilds boundary-local, and split the new topology/update flows into smaller helpers.
    - Use single node set with multiple parent-child relations to store both directory tree and chart relation tree.
    - Refine chart text presentation: move traversal guidance before the partition list, remove the redundant overview, render chart references as compact `- path` / `- scope` entries, and identify each chart with `# CHART AT <workspace path>`. The heading is now produced by the base chart builder rather than patched after rendering.
    - Remove unsupported lifecycle wiring: stop publishing the unused OpenCode start bin and Codex session-end bin; `init-codex` now migrates only its obsolete `memoryanchor-codex-post` entry while preserving user hooks.

- `2026/07/20`:
    - Speed up full chart builds by parsing each file once and sharing a build-scoped cache between registry sizing and chart emission. Submit full batches to the parser queue while lazily capping workers at available CPU parallelism minus one, and track both live and starting workers so failed initialization and shutdown cannot leave worker threads behind. Explicitly delete each web-tree-sitter Tree after symbol extraction so large builds release native AST memory promptly.

- `2026/07/19`:
    - Plan: directory-based recursive chart partitioning by tracking generated character counts per directory in the registry, then expanding small directory subtrees directly and splitting oversized ones into child directory Markdown files.
    - Incremental partition updates now use hysteresis thresholds `{ splitAt: 12000, mergeAt: 9000 }`. Each changed file locates the first non-split directory on its path, updates that chart in place, and propagates the character delta through its parent chain. Overall algorithmic complexity is `O(depth * changed)`.
    - Decision: Boundary changes propagate along at most one ancestor path. For insertion, structural propagation stops after the first affected ancestor split. Higher ancestors only require metadata updates because they have already satisfied their branching constraints. For deletion, merge operations may propagate upward if collapsing children causes ancestor nodes to violate the merge threshold. So only do recursive up when merge occured

- `2026/07/18`:
    - Rename `src/core/` to `src/chartBuild/` to better reflect the chart-generation domain. Update imports, hooks, tests, and Makefile targets to use the new module path. And rewrite `README.md` with refreshed product positioning, setup guidance, lifecycle documentation, supported-agent details, commands, examples, limitations, and contribution notes. Now, Inject `chart.md`, `ballast.md`, and `manifest.md` together at session start. Update the generated `AGENTS.md` workflow so agents reread the chart only when the overall structure is unclear, migrate existing managed AGENTS blocks in place, and remove OpenCode's legacy standalone chart instruction.

- `2026/07/17`:
    - Add three hook's autotest, and by this solve bugs: ballast santitizer will put all default rules under specfic rule's part; stop hook will call fullBuild when no git changes; santitizer(ballast) cannot treat `- [], [], [ ]` start will. BTW, ai agent cannot work will on hooks autotests.

- `2026/07/16`:
    - Find copilot's test will occasionally failed by overtime. It's might because threadpool do not have failed worker recreate mechanism. Need further explore. From afternoon, solved this bug, now threadpool can reinit the worker. And remove some duplicated redundent autotests. Then, right now, if the function is called with empty input, threadpool will not create.

- `2026/07/15`:
    - Solve opencode's plugin by substitute session.created to experimental.chat.system.transform solve the bug that init will not cover old opencode plugin js file.

- `2026/07/14`:
    - Opencode's plugin does not injecting ballast.md and manifest.md successfully, add this resolving to Todo. Change sample decision in manifest.md to make models remember to keep /n/n after each decision.

- `2026/07/08`:
    - [Known Limitation] Manual edits/deletions in chart.md are not resolved by incremental updating, because it relies on registry mtime which doesn't change. This is by design - chart.md is auto-generated and should never be edited manually. Will not occur in normal use.
