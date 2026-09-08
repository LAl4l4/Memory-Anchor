import type { CAC } from 'cac';

export function mcpCommand(cli: CAC): void {
  cli.command('mcp', 'Serve read-only chart and file queries over MCP stdio')
    .option('--workspace <path>', 'Initialized workspace root (default: current directory)')
    .action(async (options: { workspace?: string }) => {
      const { serveCharts } = await import('../mcp/server.js');
      await serveCharts(options.workspace ?? process.cwd());
    });
}
