/** Shared by session context and the MCP initialize response. */
export const MCP_USAGE_INSTRUCTIONS = `[MEMORY ANCHOR MCP]
Use memory-anchor get_chart({path}) for directory architecture and get_file({path}) for file symbols, dependencies and callers; paths are workspace-relative ("." for root). Query the task path directly; only a bounded root chart directory and module-name directory are injected, not their details.
Use get_project_state({}) to list modules and get_project_state({module}) to read the exact module name relevant to the task.
For source, use get_file with include_source: true and optional start_line/end_line; follow hasMore for additional lines. Check returned scope and freshness: charts are snapshots, possibly_stale means source is newer, and unknown does not guarantee freshness.
If MCP is unavailable or fails, read relevant source or .memoryanchor/project-state.md directly. Do not rebuild charts merely to answer a query.`;
