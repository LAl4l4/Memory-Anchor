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

- `2026/07/18`: Rename `src/core/` to `src/chartBuild/` to better reflect the chart-generation domain. Update imports, hooks, tests, and Makefile targets to use the new module path. And rewrite `README.md` with refreshed product positioning, setup guidance, lifecycle documentation, supported-agent details, commands, examples, limitations, and contribution notes.

- `2026/07/18`: Inject `chart.md`, `ballast.md`, and `manifest.md` together at session start. Update the generated `AGENTS.md` workflow so agents reread the chart only when the overall structure is unclear, migrate existing managed AGENTS blocks in place, and remove OpenCode's legacy standalone chart instruction.
