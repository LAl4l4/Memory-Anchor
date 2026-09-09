## Optimization
Implement threadPool and language load cache to reuse the parser and loaded language, 
make it sharply faster when appling initialization on large workspace.

threadPool is lazy create, it will automatically creating when necessary, but it should exit

WorkerPool will exist when you use the cli, to catch the file change after every change, 
it will destroy when you exit the cli, ensuring highest reuse amount.

Initialization will destroy the pool after it finished.

More Information is in PROJECT_SPEC.md


## Memory Anchor Rules
Memory Anchor is initialized in this repository. Follow these rules to ensure it works effectively.

### File Roles
- Memory Anchor MCP tools: get_chart({path}) reads the chart covering a directory; get_file({path}) reads one file's symbols, signatures, ranges, dependencies and callers. Prefer them over opening chart or source files directly.
- ./.memoryanchor/chart/.../chart.md: Directory-level architecture map, normally read through get_chart. Backing artifacts are located by MCP; do not manually traverse charts when MCP is available.
- ./.memoryanchor/project-state.md: Current Module Status (functionality/status/known_issues/notes); injected into session context.
- ./.memoryanchor/decisions.md: Architectural choices and their rationale; injected in full into session context.
- ./.memoryanchor/guardrails.md: Persistent repository guardrails, one per line.
- ./.memoryanchor/prompt-hooks.json: Optional UserPrompt hook selection; missing or empty means disabled.

### Chart Relationship Notation
- '+' marks an exported symbol; '-' marks the default/internal symbol. Function rows omit the words 'function'; '+' functions include only source-declared parameter/return types, while '-' functions omit signatures.
- Every symbol includes an '[Lstart-end]' source range. Source comments are not included in charts.
- '->' lists parseable repository files referenced by a file, including targets in full repository.
- '<-' lists import-resolved cross-file callers (across charts in full builds), never same-file, member, or dynamic calls; it is attached only to symbols.
- A missing '->' means no parseable repository target was resolved; package and other unresolved imports are omitted.

### Workflow
- Use get_chart on the task directory for architecture context and get_file for specific files; charts are not injected into the session.
- If the agent has any uncertainty about the overall project structure, call get_chart for the relevant directory again, then get_file on candidate files before reading their source.
- If the MCP tools are unavailable, disabled, or fail, inspect relevant source files directly. Do not rebuild charts merely to answer a query.
- Must follow all rules in ./.memoryanchor/guardrails.md. After solving a bug, first merge the lesson into an existing rule when possible. Add a new rule under "Repository-specific Guardrails" only when it represents a distinct, durable repository constraint.
- After any feature is implemented, update Module Status in ./.memoryanchor/project-state.md and, for significant architectural changes, update ./.memoryanchor/decisions.md.

### guardrails.md format
- Keep only valid rules. Delete obsolete ones.
- One line per rule, exact format: '- [ ] Rule content'

## Memory Anchor Ends
