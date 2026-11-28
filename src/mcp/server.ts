import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ChartReader } from './chartReader.js';
import { MEMORY_KINDS, MemoryStore, PROJECT_STATE_FIELDS } from './memoryStore.js';
import { getVersion } from '../commands/version.js';
import { MCP_USAGE_INSTRUCTIONS } from './instructions.js';
import * as path from 'node:path';

export async function createChartServer(workspace: string): Promise<McpServer> {
  const workspaceRoot = path.resolve(workspace);
  // Global clients can discover tools outside a workspace; queries then fail clearly.
  // Resolve a reader per request so a workspace initialized later can be queried.
  const reader = () => ChartReader.create(workspaceRoot);
  const store = () => MemoryStore.create(workspaceRoot);
  const server = new McpServer({ name: 'memory-anchor', version: getVersion() },
    { instructions: MCP_USAGE_INSTRUCTIONS });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const result = async (operation: () => Promise<unknown>) => {
    try {
      const value = await operation();
      return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: error instanceof Error ? error.message : String(error) }] };
    }
  };
  server.registerTool('get_chart', {
    description: 'Read the persisted architecture chart covering a directory. Paths are relative to the configured workspace (use . for root). A recursive chart can cover an ancestor; split wrappers return child chart routes. Charts are snapshots and may need refresh.',
    inputSchema: { path: z.string().min(1).default('.') }, annotations,
  }, args => result(async () => (await reader()).getChart(args.path)));
  server.registerTool('get_file', {
    description: 'Read one file architecture entry: symbols, signatures, ranges, dependencies and callers. Optionally read current source, default 200 lines, maximum 500 per call. Paths are workspace-relative; chart freshness is not guaranteed.',
    inputSchema: { path: z.string().min(1), include_source: z.boolean().default(false),
      start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() }, annotations,
  }, args => result(async () => (await reader()).getFile(args.path, args)));
  server.registerTool('get_project_state', {
    description: 'List project-state module names, or read one complete module by its exact name. Reads current memory without requiring chart artifacts.',
    inputSchema: { module: z.string().min(1).optional() }, annotations,
  }, args => result(async () => (await reader()).getProjectState(args.module)));
  const kind = z.enum(MEMORY_KINDS);
  server.registerTool('get_memory', {
    description: 'Read project memory. No arguments: a directory of guardrails, decision summaries and project_state modules with ids. kind: every entry of that kind (project_state lists module ids, versions and status). kind + id: one complete entry. Guardrail/decision ids derive from content and change when the entry is edited; project_state ids are module names.',
    inputSchema: { kind: kind.optional(), id: z.string().min(1).optional() }, annotations,
  }, args => result(async () => (await store()).get(args.kind, args.id)));
  server.registerTool('write_memory', {
    description: 'Add, update or remove one memory entry in .memoryanchor. Write plain language; the storage format (rule checkboxes, bullets, headings) is applied for you. guardrails: content is one rule. decisions: content is one decision (choice and rationale). project_state: id is the module name and fields sets functionality/status/dependencies/known_issues/notes (newlines are collapsed; update patches only the given fields). update/remove need a current id from get_memory. add returns similar_entries instead of writing when an existing entry overlaps; update that entry, or pass force: true when the new one is distinct.',
    inputSchema: {
      kind, op: z.enum(['add', 'update', 'remove']), id: z.string().min(1).optional(), content: z.string().optional(),
      fields: z.object(Object.fromEntries(PROJECT_STATE_FIELDS.map(field => [field, z.string().optional()])) as
        Record<typeof PROJECT_STATE_FIELDS[number], z.ZodOptional<z.ZodString>>).strict().optional(),
      version: z.string().optional(), force: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, args => result(async () => (await store()).write(args)));
  return server;
}

export async function serveCharts(workspace: string): Promise<void> {
  const server = await createChartServer(workspace);
  await server.connect(new StdioServerTransport());
}
