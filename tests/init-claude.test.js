import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitClaude(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-claude'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-claude-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .claude/settings.json with SessionStart hook', async () => {
  await runInitClaude(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.claude', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionStart).toBeDefined();
  expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('memoryanchor-claude-pre');
});

test('creates .claude/settings.json with Stop hook', async () => {
  await runInitClaude(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.claude', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.Stop).toBeDefined();
  expect(settings.hooks.Stop[0].hooks[0].command).toBe('memoryanchor-claude-stop');
});

test('creates .claude/settings.json with SessionEnd hook', async () => {
  await runInitClaude(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.claude', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionEnd).toBeDefined();
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe('memoryanchor-claude-post');
});

test('creates CLAUDE.md with memory anchor line', async () => {
  await runInitClaude(tempDir);

  const claudeMd = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
  expect(claudeMd).toContain('- Follow `AGENTS.md` for Memory Anchor rules.');
});

test('existing CLAUDE.md content is preserved', async () => {
  const claudeMdPath = path.join(tempDir, 'CLAUDE.md');
  await writeFile(claudeMdPath, '# My Custom Rules\n\nBe helpful.\n');

  await runInitClaude(tempDir);

  const content = await readFile(claudeMdPath, 'utf8');
  expect(content).toContain('# My Custom Rules');
  expect(content).toContain('Be helpful.');
  expect(content).toContain('- Follow `AGENTS.md` for Memory Anchor rules.');
});

test('re-running does not duplicate hooks', async () => {
  await runInitClaude(tempDir);
  await runInitClaude(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.claude', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.SessionEnd).toHaveLength(1);
});

test('re-running does not duplicate CLAUDE.md anchor line', async () => {
  await runInitClaude(tempDir);
  await runInitClaude(tempDir);

  const claudeMd = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
  const matches = claudeMd.match(/Follow `AGENTS\.md` for Memory Anchor rules\./g);
  expect(matches).toHaveLength(1);
});
