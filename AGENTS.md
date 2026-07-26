## Optimization
Implement threadPool and language load cache to reuse the parser and loaded language, 
make it sharply faster when appling initialization on large workspace.

threadPool is lazy create, it will automatically creating when necessary, but it should exit

WorkerPool will exist when you use the cli, to catch the file change after every change, 
it will destroy when you exit the cli, ensuring highest reuse amount.

Initialization will destroy the pool after it finished.


## Memory Anchor Rules
Memory Anchor is initialized in this repository. Follow these rules to ensure it works effectively.

### File Roles
- ./.memoryanchor/index.md: Auto-generated project chart index. Its entries point to directory-level architecture maps under ./.memoryanchor/chart/.
- ./.memoryanchor/chart/.../chart.md: Directory-level architecture map. Read the root chart at the start of every task for project-wide context, then use index.md and Child Charts to find the chart closest to the task.
- ./.memoryanchor/manifest.md: Current project state — Module Status (functionality/status/known_issues/notes) and Key Decisions (architectural choices and rationale).
- ./.memoryanchor/ballast.md: Persistent repo-specific rules/guardrails, one per line.

### Chart Relationship Notation
- '+' marks an exported symbol; '-' marks the default/internal symbol (including symbols from languages without explicit exports, such as C). Function rows omit the words 'function' and 'export'; '+' functions include only source-declared parameter/return types, while '-' functions omit signatures.
- Every symbol includes an '[Lstart-end]' source range. Source comments are not included in charts.
- '->' lists parseable repository files referenced by a file, including targets outside the current chart.
- '<-' lists current-chart symbols that depend on or call a symbol; it is attached only to the referenced symbol, never a file heading.
- Known limitation: a cross-chart '->' target may not be rendered in this chart, and '<-' deliberately omits callers from other charts. Do not treat a missing '<-' as proof that a symbol has no repository-wide callers.
- A missing '->' means no parseable repository target was resolved; package and other unresolved imports are omitted.

### Workflow
- At the start of every task, read ./.memoryanchor/chart/.../chart.md to establish a project-wide view before working on repository files.
- If the agent has any uncertainty about the overall project structure, immediately read ./.memoryanchor/index.md again, then read the closest matching directory chart listed there.
- Must follow all rules in ./.memoryanchor/ballast.md. After solving a bug, add a rule under "Ballast Specific Rules For This Repository" to prevent recurrence.
- After any of features implemented, update Module Status (and Key Decisions, if applicable) in ./.memoryanchor/manifest.md.

### ballast.md format
- Keep only valid rules. Delete obsolete ones.
- One line per rule, exact format: '- [ ] Rule content'

## Memory Anchor Ends
