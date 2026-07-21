import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_COMMANDS } from '../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitCodex(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-codex'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-codex-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .codex/hooks.json with SessionStart hook', async () => {
  await runInitCodex(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.codex', 'hooks.json'), 'utf8'),
  );
  expect(hooks.hooks.SessionStart).toBeDefined();
  expect(hooks.hooks.SessionStart[0].hooks[0].type).toBe('command');
  expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_COMMANDS.CODEX_PRE);
  expect(hooks.hooks.SessionStart[0].hooks[0].timeout).toBe(10);
});

test('creates .codex/hooks.json with Stop hook', async () => {
  await runInitCodex(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.codex', 'hooks.json'), 'utf8'),
  );
  expect(hooks.hooks.Stop).toBeDefined();
  expect(hooks.hooks.Stop[0].hooks[0].command).toBe(HOOK_COMMANDS.CODEX_STOP);
});

test('does not create an unsupported SessionEnd hook', async () => {
  await runInitCodex(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.codex', 'hooks.json'), 'utf8'),
  );
  expect(hooks.hooks.SessionEnd).toBeUndefined();
});

test('removes only the obsolete Memory Anchor SessionEnd entry', async () => {
  const hooksPath = path.join(tempDir, '.codex', 'hooks.json');
  await mkdir(path.dirname(hooksPath), { recursive: true });
  await writeFile(
    hooksPath,
    JSON.stringify({
      hooks: {
        SessionEnd: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'memoryanchor-codex-post', timeout: 10 },
              { type: 'command', command: 'my-session-end-hook', timeout: 10 },
            ],
          },
        ],
      },
    }, null, 2) + '\n',
  );

  await runInitCodex(tempDir);

  const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
  expect(hooks.hooks.SessionEnd).toHaveLength(1);
  expect(hooks.hooks.SessionEnd[0].hooks).toEqual([
    { type: 'command', command: 'my-session-end-hook', timeout: 10 },
  ]);
});

test('preserves existing hooks.json content when adding new hooks', async () => {
  const hooksPath = path.join(tempDir, '.codex', 'hooks.json');
  const preExisting = {
    hooks: {
      CustomHook: [
        {
          matcher: '*.ts',
          hooks: [{ type: 'command', command: 'my-custom-hook', timeout: 30 }],
        },
      ],
    },
    otherSetting: true,
  };
  await mkdtemp; // .codex dir is created by ensureCodexHooks, so we need to pre-create it
  const codexDir = path.join(tempDir, '.codex');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(codexDir, { recursive: true });
  await writeFile(hooksPath, JSON.stringify(preExisting, null, 2) + '\n');

  await runInitCodex(tempDir);

  const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
  expect(hooks.otherSetting).toBe(true);
  expect(hooks.hooks.CustomHook).toBeDefined();
  expect(hooks.hooks.CustomHook[0].hooks[0].command).toBe('my-custom-hook');
  expect(hooks.hooks.SessionStart).toBeDefined();
  expect(hooks.hooks.Stop).toBeDefined();
  expect(hooks.hooks.SessionEnd).toBeUndefined();
});

test('re-running does not duplicate hooks', async () => {
  await runInitCodex(tempDir);
  await runInitCodex(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.codex', 'hooks.json'), 'utf8'),
  );
  expect(hooks.hooks.SessionStart).toHaveLength(1);
  expect(hooks.hooks.Stop).toHaveLength(1);
  expect(hooks.hooks.SessionEnd).toBeUndefined();
});
