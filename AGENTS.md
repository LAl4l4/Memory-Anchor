## Optimization
Implement threadPool and language load cache to reuse the parser and loaded language, 
make it sharply faster when appling initialization on large workspace.

threadPool is lazy create, it will automatically creating when necessary, but it should exit

WorkerPool will exist when you use the cli, to catch the file change after every change, 
it will destroy when you exit the cli, ensuring highest reuse amount.

Initialization will destroy the pool after it finished.

More Information is in PROJECT_SPEC.md


## Memory Anchor Rules
Memory Anchor is initialized in this repository. Use its MCP tools for repository architecture and project memory.

### Tools
- get_chart({path}) reads the architecture chart covering a directory; get_file({path}) reads one file's symbols, signatures, ranges, dependencies and callers, and optionally its source. Prefer them over opening chart or source files directly.
- get_memory({kind, id}) reads project memory; write_memory({kind, op, id, content | fields}) adds, updates or removes one entry. Write content in plain language; write_memory applies the storage format.
- recall_memory({query, kind?, limit?}) ranks memory entries by keyword relevance and adds a few found by meaning (Chinese and English, within one language) and returns complete entries with their ids. Query with the module, file, symbol or feature names the memory would contain, or describe the topic in plain words.

### Memory Kinds
- guardrails: durable repository rules; injected in full and must be followed.
- decisions: architectural choices and their rationale; injected in full.
- project_state: module status (functionality/status/dependencies/known_issues/notes); only module names are injected. Read one module with get_memory({kind: "project_state", id: module}), or find the modules a task touches with recall_memory.

### Chart Relationship Notation
- '+' marks an exported symbol; '-' marks the default/internal symbol. Function rows omit the words 'function'; '+' functions include only source-declared parameter/return types, while '-' functions omit signatures.
- Every symbol includes an '[Lstart-end]' source range. Source comments are not included in charts.
- '->' lists parseable repository files referenced by a file, including targets in full repository.
- '<-' lists import-resolved cross-file callers (across charts in full builds), never same-file, member, or dynamic calls; it is attached only to symbols.
- A missing '->' means no parseable repository target was resolved; package and other unresolved imports are omitted.

### Workflow
- Use get_chart on the task directory for architecture context and get_file for specific files; only a bounded root chart directory is injected; chart details are read on demand.
- If the agent has any uncertainty about the overall project structure, call get_chart for the relevant directory again, then get_file on candidate files before reading their source.
- Do not rebuild charts merely to answer a query.
- After solving a bug, first merge the lesson into an existing guardrail (write_memory op "update"); add a new guardrail only for a distinct, durable repository constraint, and remove guardrails that are no longer valid.
- After any feature is implemented, update its project_state module and, for significant architectural changes, add or update a decision.

Editing .memoryanchor files directly instead of through write_memory is undefined behaviour: it bypasses the write lock and can silently overwrite or lose other agents' changes.

## Memory Anchor Ends
