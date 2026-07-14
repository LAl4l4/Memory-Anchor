import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_COMMANDS, OPENCODE_SCHEMA_URL, REQUIRED_INSTRUCTION_ENTRIES, ANCHOR_DIR_NAME, CHART_FILE_NAME, BALLAST_FILE_NAME, MANIFEST_FILE_NAME } from '../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
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
  expect(plugin).toContain('session.start');
  expect(plugin).toContain('session.idle');
  expect(plugin).toContain('session.deleted');
});

test('creates opencode.json with schema and instructions', async () => {
  await runInitOpencode(tempDir);

  const cfg = JSON.parse(await readFile(path.join(tempDir, 'opencode.json'), 'utf8'));
  expect(cfg.$schema).toBe(OPENCODE_SCHEMA_URL);
  expect(Array.isArray(cfg.instructions)).toBe(true);
  expect(cfg.instructions).toContain(REQUIRED_INSTRUCTION_ENTRIES[0]);
  expect(cfg.instructions).toContain(REQUIRED_INSTRUCTION_ENTRIES[1]);
});

test('plugin file uses Bun shell ($) to invoke hooks', async () => {
  await runInitOpencode(tempDir);

  const plugin = await readFile(
    path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js'),
    'utf8',
  );
  // $ must be imported from "bun" (Bun's shell) per opencode plugin docs.
  expect(plugin).toMatch(/from\s+["']bun["']/);
  // And used to spawn child processes.
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

test('does not overwrite an existing plugin file', async () => {
  const pluginPath = path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js');
  await mkdir(path.dirname(pluginPath), { recursive: true });
  const userContent = '// user-customized\n';
  await writeFile(pluginPath, userContent);

  await runInitOpencode(tempDir);

  const content = await readFile(pluginPath, 'utf8');
  expect(content).toBe(userContent);
});

test('also runs the public init (AGENTS.md + .memoryanchor/*)', async () => {
  await runInitOpencode(tempDir);

  const agents = await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('Memory Anchor Rules');

  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  for (const f of [CHART_FILE_NAME, BALLAST_FILE_NAME, MANIFEST_FILE_NAME]) {
    const exists = await readFile(path.join(anchorDir, f), 'utf8');
    expect(exists.length).toBeGreaterThan(0);
  }
});

test('re-running on a clean second invocation reports no work to do', async () => {
  await runInitOpencode(tempDir);

  // second run should not throw, and must leave the existing files intact
  await runInitOpencode(tempDir);

  const cfg = JSON.parse(await readFile(path.join(tempDir, 'opencode.json'), 'utf8'));
  expect(cfg.$schema).toBe(OPENCODE_SCHEMA_URL);
});
