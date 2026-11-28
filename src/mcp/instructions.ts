/** Every tool the memory-anchor server registers, in registration order. */
export const MCP_TOOL_NAMES = ['get_chart', 'get_file', 'get_memory', 'recall_memory', 'write_memory'] as const;

/** Shared by session context and the MCP initialize response. */
export const MCP_USAGE_INSTRUCTIONS = `[MEMORY ANCHOR MCP]
Use memory-anchor get_chart({path}) for directory architecture and get_file({path}) for file symbols, dependencies and callers; paths are workspace-relative ("." for root). Query the task path directly; only a bounded root chart directory and module-name directory are injected, not their details.
For source, use get_file with include_source: true and optional start_line/end_line; follow hasMore for additional lines. Check returned scope and freshness: charts are snapshots, possibly_stale means source is newer, and unknown does not guarantee freshness.
Use get_memory({}) for a memory directory, get_memory({kind}) to list guardrails, decisions or project_state, and get_memory({kind, id}) for one entry; project_state ids are module names.
Use recall_memory({query}) with a task's module, file, symbol or feature names to get the most relevant guardrails, decisions and modules ranked by keyword match, plus entries found by meaning; it returns complete entries with their ids.
Record memory with write_memory({kind, op: "add"|"update"|"remove", id, content | fields}) in plain language; it applies the storage format. On similar_entries, update the returned entry or retry with force.
Do not rebuild charts merely to answer a query. Editing .memoryanchor files directly instead of through write_memory is undefined behaviour: it bypasses the write lock and can lose other agents' changes.`;
