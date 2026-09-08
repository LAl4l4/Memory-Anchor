import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ChartReader } from './chartReader.js';
import { getVersion } from '../commands/version.js';
import { MCP_USAGE_INSTRUCTIONS } from './instructions.js';
import * as path from 'node:path';

export async function createChartServer(workspace: string): Promise<McpServer> {
  const workspaceRoot = path.resolve(workspace);
  // Global clients can discover tools outside a workspace; queries then fail clearly.
  // Resolve a reader per request so a workspace initialized later can be queried.
  const reader = () => ChartReader.create(workspaceRoot);
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
  return server;
}

export async function serveCharts(workspace: string): Promise<void> {
  const server = await createChartServer(workspace);
  await server.connect(new StdioServerTransport());
}
