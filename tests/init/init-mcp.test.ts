import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerMcp, getMcpLaunch } from '../../dist/commands/initHelper/initMcp.js';
import { buildMemoryCore } from '../../dist/hooks/public/memoryCore.js';
import { PROMPT_HOOK_AGENTS } from '../../dist/constant.js';

const run = promisify(execFile);
const cliPath = path.resolve('dist/cli.js');
const priorHermesHome = process.env.HERMES_HOME;
let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'anchor-init-mcp-'));
  process.env.HERMES_HOME = path.join(workspace, 'hermes-home');
});
afterEach(async () => {
  if (priorHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = priorHermesHome;
  await rm(workspace, { recursive: true, force: true });
});

async function put(file: string, content: string) {
  const target = path.join(workspace, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

test.each(PROMPT_HOOK_AGENTS)('init-%s registers a launchable server and injects tool guidance', async agent => {
  await put('src/demo.ts', 'export function demo() { return 1; }\n');
  await run(process.execPath, [cliPath, `init-${agent}`], {
    cwd: workspace, env: { ...process.env, HOME: path.join(workspace, 'user-home'), HERMES_HOME: path.join(workspace, 'hermes-home') }, timeout: 15000,
  });
  let config;
  if (agent === 'codex') {
    config = (parseToml(await readFile(path.join(workspace, '.codex/config.toml'), 'utf8')).mcp_servers as any)['memory-anchor'];
  } else if (agent === 'hermes') {
    config = parseDocument(await readFile(path.join(workspace, 'hermes-home/config.yaml'), 'utf8')).toJS().mcp_servers['memory-anchor'];
    expect(config.args).not.toContain('--workspace');
  } else if (agent === 'qwencode') {
    config = JSON.parse(await readFile(path.join(workspace, '.qwen/settings.json'), 'utf8')).mcpServers['memory-anchor'];
  } else if (agent === 'zcode') {
    config = JSON.parse(await readFile(path.join(workspace, '.zcode/config.json'), 'utf8')).mcp.servers['memory-anchor'];
  } else if (agent === 'deepseek') {
    const patches = parseDocument(await readFile(path.join(workspace, '.memoryanchor/deepseek/cordis.patch.yml'), 'utf8')).toJS();
    config = patches.flatMap((patch: any) => patch.insert ?? []).find((entry: any) => entry.id === 'memory-anchor-mcp').config;
  } else if (agent === 'opencode') {
    const server = JSON.parse(await readFile(path.join(workspace, 'opencode.json'), 'utf8')).mcp['memory-anchor'];
    expect(server).toMatchObject({ type: 'local', enabled: true });
    config = { command: server.command[0], args: server.command.slice(1) };
  } else {
    config = JSON.parse(await readFile(path.join(workspace, '.mcp.json'), 'utf8')).mcpServers['memory-anchor'];
    expect(config).toMatchObject({ type: 'stdio', tools: ['get_chart', 'get_file'] });
  }
  const client = new Client({ name: 'init-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: workspace, stderr: 'pipe' });
  try {
    await client.connect(transport);
    expect(client.getInstructions()).toContain('[MEMORY ANCHOR MCP]');
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['get_chart', 'get_file', 'get_project_state']);
    const result = await client.callTool({ name: 'get_file', arguments: { path: 'src/demo.ts' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('demo()');
  } finally { await client.close(); }
  const context = buildMemoryCore(workspace);
  expect(context).toContain('[MEMORY ANCHOR MCP]');
  expect(context).toContain('get_chart');
  expect(context).toContain('get_file');
  expect(context).toContain('If MCP is unavailable');
  expect(context).not.toContain('[ROOT CHART ALREADY INJECTED');
  expect(context).not.toContain('index.md');
}, 20000);

test('combined init registers each format and rerunning registration is byte-idempotent', async () => {
  await run(process.execPath, [cliPath, 'init'], {
    cwd: workspace, env: { ...process.env, HOME: path.join(workspace, 'user-home'), HERMES_HOME: path.join(workspace, 'hermes-home') }, timeout: 15000,
  });
  const files = ['.mcp.json', '.codex/config.toml', 'opencode.json', 'hermes-home/config.yaml', '.qwen/settings.json', '.zcode/config.json', '.memoryanchor/deepseek/cordis.patch.yml'];
  const before = await Promise.all(files.map(file => readFile(path.join(workspace, file), 'utf8')));
  for (const agent of PROMPT_HOOK_AGENTS) expect(await registerMcp(workspace, agent)).toBe(false);
  expect(await Promise.all(files.map(file => readFile(path.join(workspace, file), 'utf8')))).toEqual(before);
}, 20000);

test('preserves unrelated JSON servers and existing disabled/custom entries', async () => {
  await put('.mcp.json', JSON.stringify({ mcpServers: { user: { command: 'custom', args: [] } }, extra: 42 }));
  await registerMcp(workspace, 'claude');
  const config = JSON.parse(await readFile(path.join(workspace, '.mcp.json'), 'utf8'));
  expect(config.mcpServers.user.command).toBe('custom');
  expect(config.extra).toBe(42);
  const custom = '{"mcp":{"memory-anchor":{"enabled":false},"other":{"type":"remote","url":"https://example.test"}},"tools":{"memory-anchor_*":false}}';
  await put('opencode.json', custom);
  expect(await registerMcp(workspace, 'opencode')).toBe(false);
  expect(await readFile(path.join(workspace, 'opencode.json'), 'utf8')).toBe(custom);
});

test('preserves TOML comments and settings, including quoted existing server names', async () => {
  const original = '# my preference\nmodel = "example"\n[mcp_servers.user]\ncommand = "custom"\n';
  await put('.codex/config.toml', original);
  await registerMcp(workspace, 'codex');
  const next = await readFile(path.join(workspace, '.codex/config.toml'), 'utf8');
  expect(next.startsWith(original)).toBe(true);
  expect((parseToml(next).mcp_servers as any)['memory-anchor']).toMatchObject(getMcpLaunch(workspace));
  const disabled = '[mcp_servers."memory-anchor"]\ncommand = "my-launcher"\nenabled = false\n';
  await put('.codex/config.toml', disabled);
  expect(await registerMcp(workspace, 'codex')).toBe(false);
  expect(await readFile(path.join(workspace, '.codex/config.toml'), 'utf8')).toBe(disabled);
});

test('normalizes a bare Copilot server map without hiding existing servers', async () => {
  await put('.mcp.json', '{"other":{"command":"custom","args":[]}}');
  await registerMcp(workspace, 'copilot');
  const config = JSON.parse(await readFile(path.join(workspace, '.mcp.json'), 'utf8'));
  expect(config.mcpServers.other).toEqual({ command: 'custom', args: [] });
  expect(config.mcpServers['memory-anchor']).toBeDefined();
});

test.each<['claude' | 'codex' | 'hermes', string, string]>([
  ['claude', '.mcp.json', '{broken'],
  ['claude', '.mcp.json', '{"mcpServers":[]}'],
  ['codex', '.codex/config.toml', 'model = ['],
  ['hermes', 'hermes-home/config.yaml', 'mcp_servers: []\n'],
])('rejects invalid %s configuration without writing it', async (agent, file, original) => {
  await put(file, original);
  await expect(registerMcp(workspace, agent)).rejects.toThrow();
  expect(await readFile(path.join(workspace, file), 'utf8')).toBe(original);
});

test('preserves Hermes YAML comments and does not bind global config to another workspace', async () => {
  await put('hermes-home/config.yaml', '# keep this\nmodel: my-model\nmcp_servers:\n  other:\n    command: custom # keep inline\n');
  await registerMcp(workspace, 'hermes');
  const content = await readFile(path.join(workspace, 'hermes-home/config.yaml'), 'utf8');
  expect(content).toContain('# keep this');
  expect(content).toContain('# keep inline');
  expect(content).not.toContain('--workspace');
  const another = path.join(workspace, 'another');
  await mkdir(another);
  await registerMcp(another, 'hermes');
  expect(await readFile(path.join(workspace, 'hermes-home/config.yaml'), 'utf8')).toBe(content);
  // Even outside an initialized repo the global server can complete discovery.
  const launch = getMcpLaunch();
  const client = new Client({ name: 'outside-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ ...launch, cwd: another, stderr: 'pipe' }));
    expect((await client.listTools()).tools).toHaveLength(3);
    expect((await client.callTool({ name: 'get_chart', arguments: { path: '.' } })).isError).toBe(true);
  } finally { await client.close(); }
});
