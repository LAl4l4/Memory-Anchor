/** Shared by session context and the MCP initialize response. */
export const MCP_USAGE_INSTRUCTIONS = `[MEMORY ANCHOR MCP]
When the memory-anchor MCP tools are available, prefer them for directory and file architecture queries. Clients may prefix tool names; use the tools exposed by the memory-anchor server.
- get_chart({path: "src/example"}): read the chart covering a directory. Use workspace-relative paths, or "." for the root. Check the returned scope: recursive charts can cover an ancestor, and split wrappers return child chart routes.
- get_file({path: "src/example/file.ts"}): read just that file's symbols, signatures, line ranges, dependencies and callers.
- For implementation details, use get_file with include_source: true and optional start_line/end_line (1-based, inclusive; default 200 lines, maximum 500). Use hasMore to continue reading.
The injected root chart already supplies root context; do not fetch it again unless needed. Read a relevant chart before exploring its source files.
Charts are persisted snapshots. possibly_stale means the source is newer; unknown is not proof of freshness. When a chart is stale or a file is not indexed, inspect current source before drawing conclusions.
If MCP tools are unavailable, disabled, or fail, follow .memoryanchor/index.md and read the relevant chart/source files directly. Do not rebuild charts merely to answer a query. These read-only tools do not replace graph tracing or literal-text search.`;
