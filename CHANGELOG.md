## Update log
- `2026/07/08`: [Known Limitation] Manual edits/deletions in chart.md are not resolved by incremental updating, because it relies on registry mtime which doesn't change. This is by design - chart.md is auto-generated and should never be edited manually. Will not occur in normal use.

- `2026/07/14`: Opencode's plugin does not injecting ballast.md and manifest.md successfully, add this
resolving to Todo. Change sample decision in manifest.md to make models remember to keep /n/n after each decision.

- `2026/07/15`: Solve opencode's plugin by substitute session.created to experimental.chat.system.transform
solve the bug that init will not cover old opencode plugin js file.

- `2026/07/16`: Find copilot's test will occasionally failed by overtime. It's might because threadpool
do not have failed worker recreate mechanism. Need further explore. From afternoon, solved this bug, now
threadpool can reinit the worker. And remove some duplicated redundent autotests. Then, right now, if the function is called with empty input, threadpool will not create.

- `2026/07/17`: Add three hook's autotest, and by this solve bugs: ballast santitizer will put all default rules under specfic rule's part; stop hook will call fullBuild when no git changes; santitizer(ballast) cannot treat `- [], [], [ ]` start will. BTW, ai agent cannot work will on hooks autotests.

- `2026/07/18`: Rename `src/core/` to `src/chartBuild/` to better reflect the chart-generation domain. Update imports, hooks, tests, and Makefile targets to use the new module path. And rewrite `README.md` with refreshed product positioning, setup guidance, lifecycle documentation, supported-agent details, commands, examples, limitations, and contribution notes. Now, Inject `chart.md`, `ballast.md`, and `manifest.md` together at session start. Update the generated `AGENTS.md` workflow so agents reread the chart only when the overall structure is unclear, migrate existing managed AGENTS blocks in place, and remove OpenCode's legacy standalone chart instruction.

- `2026/07/19`:
    - Plan: directory-based recursive chart partitioning by tracking generated character counts per directory in the registry, then expanding small directory subtrees directly and splitting oversized ones into child directory Markdown files.
    - Incremental partition updates now use hysteresis thresholds `{ splitAt: 12000, mergeAt: 9000 }`. Each changed file locates the first non-split directory on its path, updates that chart in place, and propagates the character delta through its parent chain. Overall algorithmic complexity is `O(depth * changed)`.
    - Decision: Boundary changes propagate along at most one ancestor path. For insertion, structural propagation stops after the first affected ancestor split. Higher ancestors only require metadata updates because they have already satisfied their branching constraints. For deletion, merge operations may propagate upward if collapsing children causes ancestor nodes to violate the merge threshold. So only do recursive up when merge occured

- `2026/07/20`:
    - Speed up full chart builds by parsing each file once and sharing a build-scoped cache between registry sizing and chart emission. Submit full batches to the parser queue while lazily capping workers at available CPU parallelism minus one, and track both live and starting workers so failed initialization and shutdown cannot leave worker threads behind. Explicitly delete each web-tree-sitter Tree after symbol extraction so large builds release native AST memory promptly.

- `2026/07/21`:
    - Replace directory-per-chart expansion with a virtual threshold-frontier chart tree. Small projects flatten into one root chart; split ancestors with direct files own shallow charts that link to the next frontier chart.
    - Persist virtual chart parent/children paths, expose every chart's path, always inject index routing rules, and additionally inject the root chart when it exists.
    - Remove repeated per-file glob scans, keep split/merge rebuilds boundary-local, and split the new topology/update flows into smaller helpers.
    - Use single node set with multiple parent-child relations to store both directory tree and chart relation tree.
    - Refine chart text presentation: move traversal guidance before the partition list, remove the redundant overview, render chart references as compact `- path` / `- scope` entries, and identify each chart with `# CHART AT <workspace path>`. The heading is now produced by the base chart builder rather than patched after rendering.
    - Remove unsupported lifecycle wiring: stop publishing the unused OpenCode start bin and Codex session-end bin; `init-codex` now migrates only its obsolete `memoryanchor-codex-post` entry while preserving user hooks.

- `2026/07/21`: 
    - Observed that constraint by agents.md is not strong enough, low level model will glob and grep without read the chart.

- `2026/07/24`:
    - Add non-blocking per-user-prompt chart reminders for Claude, Codex, CodeBuddy, Qoder, Copilot, and OpenCode. OpenCode's plugin is now type-checked and compiled from TypeScript before init copies the generated JavaScript into the workspace.

- `2026/07/24`:
    - 需要增加hook 触发测试，通过真实输入opencode启动agent，输入命令启动测试，然后ctrl+c退出测试是否真的成功调用了hook

- `2026/07/26`:
    - Enrich generated chart nodes from the existing single Tree-sitter traversal: charts now show repository-wide file dependencies (`->`), chart-local imported-symbol reverse callers (`<-`), export/internal visibility (`+` / `-`), source line ranges, and source-declared types for exported functions. The relationship legend is injected once through generated `AGENTS.md`; source comment summaries and unresolved external package dependencies are deliberately omitted.
    - Resolve file-heading `->` edges against every parseable repository file, including cross-chart targets, because they serve as low-cost module-coupling navigation. Keep `<-` edges chart-local and attach them only to the referenced function or symbol: file-level reverse edges blur which declaration is used, create misleading impact sets for multi-symbol files, and add unnecessary work and output during incremental refreshes.
    - Raise partition hysteresis thresholds to `{ splitAt: 18000, mergeAt: 14000 }`, reducing chart fragmentation while retaining a 4,000-character merge buffer.
