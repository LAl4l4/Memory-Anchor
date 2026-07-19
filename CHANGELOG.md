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

- `2026/07/20`: Speed up full chart builds by parsing each file once and sharing a build-scoped cache between registry sizing and chart emission. Submit full batches to the parser queue while lazily capping workers at available CPU parallelism minus one, and track both live and starting workers so failed initialization and shutdown cannot leave worker threads behind. Explicitly delete each web-tree-sitter Tree after symbol extraction so large builds release native AST memory promptly.
