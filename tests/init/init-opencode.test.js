import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BALLAST_MAX_BYTES, HOOK_COMMANDS, OPENCODE_SCHEMA_URL, REQUIRED_INSTRUCTION_ENTRIES } from '../../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitOpencode(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-opencode'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-opencode-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .opencode/plugins/memory-anchor.js', async () => {
  await runInitOpencode(tempDir);

  const plugin = await readFile(
    path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js'),
    'utf8',
  );
  expect(plugin).toContain('export const MemoryAnchorPlugin');
  expect(plugin).toContain(HOOK_COMMANDS.OPENCODE);
  // Context injection must go through the documented system-transform hook,
  // NOT through a (non-existent) "session.start" event.
  expect(plugin).toContain('experimental.chat.system.transform');
  expect(plugin).toContain('experimental.chat.messages.transform');
  expect(plugin).not.toContain("'chat.message':");
  expect(plugin).toContain('[IMPORTANT!] Must read ./.memoryanchor/chart/.../chart.md before any works and glob/grep.');
  expect(plugin).toContain('function resolveWorkspaceRoot(directory, worktree)');
  expect(plugin).toContain("fs.existsSync(path.join(candidate, '.memoryanchor'))");
  expect(plugin).toContain("const anchorDir = path.join(workspaceRoot, '.memoryanchor');");
  expect(plugin).toContain('[INDEX ROUTING RULES — ALWAYS INJECTED]');
  expect(plugin).toContain('[ROOT CHART ALREADY INJECTED — DO NOT READ IT AGAIN]');
  expect(plugin).toContain('readFileSafe(indexPath');
  expect(plugin).toContain('fs.existsSync(rootChartPath)');
  expect(plugin).toContain('cd ${workspaceRoot} && ${HOOK_BIN}-post');
  expect(plugin).toContain('[1. CHART (project structure & architectural symbols)]');
  expect(plugin).toContain('[2. BALLAST (rules must follow)]');
  expect(plugin).toContain('[3. MANIFEST (module status & key decisions)]');
  expect(plugin).not.toContain('session.start');
  expect(plugin).not.toContain('memoryanchor-opencode-pre');
  // session.idle is the Codex-style session-end fallback. session.deleted
  // means a stored conversation was deleted, not that the OpenCode CLI exited.
  expect(plugin).toContain('session.idle');
  expect(plugin).not.toContain("&& event.type !== 'session.deleted'");
  expect(plugin).toContain('${HOOK_BIN}-post');
  expect(plugin).not.toContain('${HOOK_BIN}-stop');
});

test('copies the TypeScript-compiled plugin verbatim', async () => {
  await runInitOpencode(tempDir);

  const [plugin, compiledPlugin] = await Promise.all([
    readFile(path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js'), 'utf8'),
    readFile(path.join(repoRoot, 'dist', 'hooks', 'opencode', 'memory-anchor-plugin.js'), 'utf8'),
  ]);
  expect(plugin).toBe(compiledPlugin);
});

test('adds the reminder to the outbound OpenCode message copy without changing message IDs', async () => {
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(
    path.join(tempDir, '.memoryanchor', 'prompt-hooks.json'),
    JSON.stringify({ enabled: ['opencode'] }) + '\n',
  );
  const { MemoryAnchorPlugin } = await import('../../dist/hooks/opencode/memory-anchor-plugin.js');
  const hooks = await MemoryAnchorPlugin({
    $: () => ({ quiet: async () => undefined }),
  });
  const output = {
    messages: [
      {
        info: { role: 'user' },
        parts: [
          { id: 'prt_file', messageID: 'msg_test', sessionID: 'ses_test', type: 'file' },
          { id: 'prt_text', messageID: 'msg_test', sessionID: 'ses_test', type: 'text', text: 'Inspect this.' },
        ],
      },
    ],
  };

  await hooks['experimental.chat.messages.transform']({}, output);

  expect(output.messages[0].parts).toHaveLength(2);
  expect(output.messages[0].parts[1].id).toBe('prt_text');
  expect(output.messages[0].parts[1].text).toBe(
    'Inspect this.\n\n[IMPORTANT!] Must read ./.memoryanchor/chart/.../chart.md before any works and glob/grep.',
  );
});

test('does not add the OpenCode reminder when the hook is disabled', async () => {
  const { MemoryAnchorPlugin } = await import('../../dist/hooks/opencode/memory-anchor-plugin.js');
  const hooks = await MemoryAnchorPlugin({
    $: () => ({ quiet: async () => undefined }),
  });
  const output = {
    messages: [
      {
        info: { role: 'user' },
        parts: [
          { id: 'prt_text_disabled', messageID: 'msg_disabled', sessionID: 'ses_disabled', type: 'text', text: 'Inspect this.' },
        ],
      },
    ],
  };

  await hooks['experimental.chat.messages.transform']({}, output);

  expect(output.messages[0].parts[0].text).toBe('Inspect this.');
});

test('OpenCode requests memory compaction when ballast exceeds its byte limit', async () => {
  const anchorDir = path.join(tempDir, '.memoryanchor');
  await mkdir(anchorDir, { recursive: true });
  await writeFile(path.join(anchorDir, 'ballast.md'), `- [ ] ${'x'.repeat(BALLAST_MAX_BYTES)}`);
  await writeFile(path.join(anchorDir, 'manifest.md'), '## Module Status\n### core');

  const { MemoryAnchorPlugin } = await import('../../dist/hooks/opencode/memory-anchor-plugin.js');
  const hooks = await MemoryAnchorPlugin({
    directory: tempDir,
    $: () => ({ quiet: async () => undefined }),
  });
  const output = { system: [] };

  await hooks['experimental.chat.system.transform']({}, output);

  expect(output.system.join('\n')).toContain('[TRIGGERED MISSION: MEMORY COMPACTION]');
  expect(output.system.join('\n')).toContain('Shorten `ballast.md`');
});

test('uses OpenCode worktree for context and lifecycle commands', async () => {
  const nestedDirectory = path.join(tempDir, 'nested');
  await mkdir(nestedDirectory);
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(path.join(tempDir, '.memoryanchor', 'index.md'), '# worktree index\n');

  const commands = [];
  const { MemoryAnchorPlugin } = await import('../../dist/hooks/opencode/memory-anchor-plugin.js');
  const hooks = await MemoryAnchorPlugin({
    directory: nestedDirectory,
    worktree: tempDir,
    $: (strings, ...values) => {
      commands.push({ strings: [...strings], values });
      return { quiet: async () => undefined };
    },
  });

  const systemOutput = { system: [] };
  await hooks['experimental.chat.system.transform']({}, systemOutput);
  expect(systemOutput.system.join('\n')).toContain('# worktree index');

  await hooks.event({ event: { type: 'session.idle' } });
  expect(commands).toHaveLength(1);
  expect(commands[0].strings.join('')).toContain('cd ');
  expect(commands[0].strings.join('')).toContain('-post');
  expect(commands[0].values).toContain(tempDir);

  await hooks.event({ event: { type: 'session.deleted' } });
  expect(commands).toHaveLength(1);
});

test('uses OpenCode directory when worktree does not contain the Memory Anchor state', async () => {
  const nestedDirectory = path.join(tempDir, 'nested');
  await mkdir(nestedDirectory);
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(path.join(tempDir, '.memoryanchor', 'index.md'), '# directory index\n');

  const { MemoryAnchorPlugin } = await import('../../dist/hooks/opencode/memory-anchor-plugin.js');
  const hooks = await MemoryAnchorPlugin({
    directory: tempDir,
    worktree: path.dirname(tempDir),
    $: () => ({ quiet: async () => undefined }),
  });

  const systemOutput = { system: [] };
  await hooks['experimental.chat.system.transform']({}, systemOutput);
  expect(systemOutput.system.join('\n')).toContain('# directory index');
});

test('creates opencode.json with schema and instructions', async () => {
  await runInitOpencode(tempDir);

  const cfg = JSON.parse(await readFile(path.join(tempDir, 'opencode.json'), 'utf8'));
  expect(cfg.$schema).toBe(OPENCODE_SCHEMA_URL);
  expect(Array.isArray(cfg.instructions)).toBe(true);
  expect(cfg.instructions).toContain(REQUIRED_INSTRUCTION_ENTRIES[0]);
  expect(cfg.instructions).not.toContain('./.memoryanchor/chart.md');
});

test('removes the legacy standalone chart instruction because the plugin injects it', async () => {
  const cfgPath = path.join(tempDir, 'opencode.json');
  await writeFile(
    cfgPath,
    JSON.stringify({ instructions: ['./.memoryanchor/chart.md', './.memoryanchor/index.md', './custom.md'] }, null, 2) + '\n',
  );

  await runInitOpencode(tempDir);

  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  expect(cfg.instructions).not.toContain('./.memoryanchor/chart.md');
  expect(cfg.instructions).not.toContain('./.memoryanchor/index.md');
  expect(cfg.instructions).toContain('./custom.md');
  expect(cfg.instructions).toContain('./AGENTS.md');
});

test('plugin file destructures $ from ctx and uses Bun shell to invoke hooks', async () => {
  await runInitOpencode(tempDir);

  const plugin = await readFile(
    path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js'),
    'utf8',
  );
  // Per the opencode plugin contract, `$` (BunShell) is provided via the
  // PluginInput ctx — it must NOT be imported bare from "bun".
  expect(plugin).not.toMatch(/from\s+["']bun["']/);
  expect(plugin).toMatch(/\{\s*\$\s*,/);
  // And used to spawn child processes for side-effect hooks.
  expect(plugin).toMatch(/\$\s*`/);
});

test('preserves existing opencode.json keys (model, provider, mcp, …)', async () => {
  const cfgPath = path.join(tempDir, 'opencode.json');
  await writeFile(
    cfgPath,
    JSON.stringify(
      {
        model: 'anthropic/claude-sonnet-4-5',
        provider: { anthropic: { options: { apiKey: 'test-key' } } },
        mcp: { jira: { type: 'remote', url: 'https://example.com' } },
      },
      null,
      2,
    ) + '\n',
  );

  await runInitOpencode(tempDir);

  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  // user-set keys survive untouched
  expect(cfg.model).toBe('anthropic/claude-sonnet-4-5');
  expect(cfg.provider.anthropic.options.apiKey).toBe('test-key');
  expect(cfg.mcp.jira.url).toBe('https://example.com');
  // and we still got our schema + instructions layered on top
  expect(cfg.$schema).toBe(OPENCODE_SCHEMA_URL);
  expect(cfg.instructions).toContain(REQUIRED_INSTRUCTION_ENTRIES[0]);
});

test('does not duplicate instructions across re-runs', async () => {
  await runInitOpencode(tempDir);
  await runInitOpencode(tempDir);

  const cfg = JSON.parse(await readFile(path.join(tempDir, 'opencode.json'), 'utf8'));
  const occurrences = cfg.instructions.filter(
    (entry) => entry === REQUIRED_INSTRUCTION_ENTRIES[0],
  );
  expect(occurrences).toHaveLength(1);
});

test('If old memory-anchor.js file does not consist with newest version, overwrite it', async () => {
  const pluginPath = path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js');
  await mkdir(path.dirname(pluginPath), { recursive: true });
  const userContent = '// user-customized\n';
  await writeFile(pluginPath, userContent);

  await runInitOpencode(tempDir);

  const content = await readFile(pluginPath, 'utf8');
  expect(content).not.toBe(userContent);
  expect(content).toContain('experimental.chat.system.transform');
});

test('replaces a known-buggy v1 plugin file (one that uses the non-existent "session.start" event)', async () => {
  const pluginPath = path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js');
  await mkdir(path.dirname(pluginPath), { recursive: true });
  // v1 template: uses the non-existent "session.start" event.
  const buggyV1 = `import { $ } from "bun";
export const MemoryAnchorPlugin = async () => ({
  "session.start": async () => { run("pre"); },
});
`;
  await writeFile(pluginPath, buggyV1);

  await runInitOpencode(tempDir);

  const content = await readFile(pluginPath, 'utf8');
  expect(content).not.toBe(buggyV1);
  expect(content).toContain('experimental.chat.system.transform');
  expect(content).not.toContain('session.start');
});

test('re-running on a clean second invocation reports no work to do', async () => {
  await runInitOpencode(tempDir);

  // second run should not throw, and must leave the existing files intact
  await runInitOpencode(tempDir);

  const cfg = JSON.parse(await readFile(path.join(tempDir, 'opencode.json'), 'utf8'));
  expect(cfg.$schema).toBe(OPENCODE_SCHEMA_URL);
});
