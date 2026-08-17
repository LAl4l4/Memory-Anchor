import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_COMMANDS } from '../../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitQodercn(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-qodercn'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-qodercn-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .qoder/settings.json with SessionStart hook', async () => {
  await runInitQodercn(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.qoder', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionStart).toBeDefined();
  expect(settings.hooks.SessionStart[0].hooks[0].type).toBe('command');
  expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_COMMANDS.QODERCN_PRE);
  expect(settings.hooks.SessionStart[0].hooks[0].timeout).toBe(5);
});

test('creates .qoder/settings.json with Stop hook', async () => {
  await runInitQodercn(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.qoder', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.Stop).toBeDefined();
  expect(settings.hooks.Stop[0].hooks[0].command).toBe(HOOK_COMMANDS.QODERCN_STOP);
  expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(10);
});

test('does not create a UserPromptSubmit hook by default', async () => {
  await runInitQodercn(tempDir);
  const settings = JSON.parse(await readFile(path.join(tempDir, '.qoder', 'settings.json'), 'utf8'));
  expect(settings.hooks.UserPromptSubmit).toBeUndefined();
});

test('creates UserPromptSubmit hook when QoderCLI CN is enabled', async () => {
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(
    path.join(tempDir, '.memoryanchor', 'prompt-hooks.json'),
    JSON.stringify({ enabled: ['qodercn'] }) + '\n',
  );
  await runInitQodercn(tempDir);
  const settings = JSON.parse(await readFile(path.join(tempDir, '.qoder', 'settings.json'), 'utf8'));
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(HOOK_COMMANDS.QODERCN_PROMPT);
});

test('creates .qoder/settings.json with SessionEnd hook', async () => {
  await runInitQodercn(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.qoder', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionEnd).toBeDefined();
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe(HOOK_COMMANDS.QODERCN_POST);
  expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(10);
});

test('hooks include matcher field', async () => {
  await runInitQodercn(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.qoder', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionStart[0].matcher).toBe('');
  expect(settings.hooks.Stop[0].matcher).toBe('');
  expect(settings.hooks.SessionEnd[0].matcher).toBe('');
});

test('preserves existing settings.json content when adding hooks', async () => {
  const qoderDir = path.join(tempDir, '.qoder');
  const settingsPath = path.join(qoderDir, 'settings.json');
  await mkdir(qoderDir, { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        permissions: { allow: ['Read', 'Glob'] },
        model: 'default',
      },
      null,
      2,
    ) + '\n',
  );

  await runInitQodercn(tempDir);

  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  expect(settings.permissions).toBeDefined();
  expect(settings.permissions.allow).toEqual(['Read', 'Glob']);
  expect(settings.model).toBe('default');
  expect(settings.hooks.SessionStart).toBeDefined();
  expect(settings.hooks.Stop).toBeDefined();
  expect(settings.hooks.SessionEnd).toBeDefined();
});

test('re-running does not duplicate hooks', async () => {
  await runInitQodercn(tempDir);
  await runInitQodercn(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.qoder', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.UserPromptSubmit).toBeUndefined();
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.SessionEnd).toHaveLength(1);
});

test('adds .qoder to .gitignore', async () => {
  await runInitQodercn(tempDir);

  const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
  expect(gitignore).toContain('.qoder');
});
