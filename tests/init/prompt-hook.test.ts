import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_COMMANDS, PROMPT_HOOK_AGENTS } from '../../dist/constant.js';
import { isSeq, parseDocument } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runPromptHook(cwd: string, args: string[] = []): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, 'prompt-hook', ...args],
      { cwd, env: { ...process.env, HERMES_HOME: path.join(cwd, 'hermes-home') } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function readJson(...parts: string[]) {
  return JSON.parse(await readFile(path.join(tempDir, ...parts), 'utf8'));
}

function toJson(value: unknown): unknown {
  const candidate = value as { toJSON?: unknown } | null;
  if (candidate && typeof candidate.toJSON === 'function') return candidate.toJSON();
  throw new Error('Expected a YAML node with toJSON()');
}

function getHookCommands(document: ReturnType<typeof parseDocument>): unknown[] {
  const hooks = document.getIn(['hooks', 'pre_llm_call']);
  if (!isSeq(hooks)) throw new Error('Expected pre_llm_call hooks in Hermes config');
  return hooks.items.map(toJson);
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-prompt-hook-'));
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(path.join(tempDir, '.memoryanchor', 'index.md'), '# test index\n');
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('selects exact agents and enables all agents when no selection is supplied', async () => {
  await runPromptHook(tempDir, ['claude', 'codex']);

  expect(await readJson('.memoryanchor', 'prompt-hooks.json')).toEqual({
    enabled: ['claude', 'codex'],
  });
  expect((await readJson('.claude', 'settings.json')).hooks.UserPromptSubmit[0].hooks[0].command)
    .toBe(HOOK_COMMANDS.CLAUDE_PROMPT);
  expect((await readJson('.codex', 'hooks.json')).hooks.UserPromptSubmit[0].hooks[0].command)
    .toBe(HOOK_COMMANDS.CODEX_PROMPT);

  await runPromptHook(tempDir);

  expect((await readJson('.memoryanchor', 'prompt-hooks.json')).enabled).toEqual(PROMPT_HOOK_AGENTS);
  expect((await readJson('.codebuddy', 'settings.json')).hooks.UserPromptSubmit[0].hooks[0].command)
    .toBe(HOOK_COMMANDS.CODEBUDDY_PROMPT);
  expect((await readJson('.qoder', 'settings.json')).hooks.UserPromptSubmit[0].hooks[0].command)
    .toBe(HOOK_COMMANDS.QODERCN_PROMPT);
  expect((await readJson('.github', 'hooks', 'memory-anchor.json')).hooks.userPromptTransformed[0].bash)
    .toBe(HOOK_COMMANDS.COPILOT_PROMPT);
  expect(await readFile(path.join(tempDir, '.opencode', 'plugins', 'memory-anchor.js'), 'utf8'))
    .toMatch(/config\.enabled\.includes\(['"]opencode['"]\)/);

  const hermesConfig = parseDocument(
    await readFile(path.join(tempDir, 'hermes-home', 'config.yaml'), 'utf8'),
  );
  const preLlmCall = getHookCommands(hermesConfig);
  expect(preLlmCall).toEqual([
    { command: HOOK_COMMANDS.HERMES_PRE, timeout: 5 },
    { command: HOOK_COMMANDS.HERMES_PROMPT, timeout: 5 },
  ]);
});

test('--off removes only the selected prompt hook', async () => {
  await runPromptHook(tempDir);
  await runPromptHook(tempDir, ['--off', 'codex']);

  expect((await readJson('.memoryanchor', 'prompt-hooks.json')).enabled).toEqual(
    PROMPT_HOOK_AGENTS.filter((agent) => agent !== 'codex'),
  );
  expect((await readJson('.codex', 'hooks.json')).hooks.UserPromptSubmit).toBeUndefined();
  expect((await readJson('.claude', 'settings.json')).hooks.UserPromptSubmit).toBeDefined();
});

test('--off removes the Hermes prompt entry from the global config', async () => {
  await runPromptHook(tempDir);
  await runPromptHook(tempDir, ['--off', 'hermes']);

  expect((await readJson('.memoryanchor', 'prompt-hooks.json')).enabled).toEqual(
    PROMPT_HOOK_AGENTS.filter((agent) => agent !== 'hermes'),
  );

  const hermesConfig = parseDocument(
    await readFile(path.join(tempDir, 'hermes-home', 'config.yaml'), 'utf8'),
  );
  const preLlmCall = getHookCommands(hermesConfig);
  expect(preLlmCall).toEqual([{ command: HOOK_COMMANDS.HERMES_PRE, timeout: 5 }]);
});
