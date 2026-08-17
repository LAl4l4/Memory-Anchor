import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_COMMANDS, AGENTS_ANCHOR_LINE } from '../../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitCopilot(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-copilot'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-copilot-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .github/hooks/memory-anchor.json with sessionStart hook', async () => {
  await runInitCopilot(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.github', 'hooks', 'memory-anchor.json'), 'utf8'),
  );
  expect(hooks.hooks.sessionStart).toBeDefined();
  expect(hooks.hooks.sessionStart[0].type).toBe('command');
  expect(hooks.hooks.sessionStart[0].bash).toBe(HOOK_COMMANDS.COPILOT_PRE);
  expect(hooks.hooks.sessionStart[0].powershell).toBe(HOOK_COMMANDS.COPILOT_PRE);
});

test('creates .github/hooks/memory-anchor.json with agentStop hook', async () => {
  await runInitCopilot(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.github', 'hooks', 'memory-anchor.json'), 'utf8'),
  );
  expect(hooks.hooks.agentStop).toBeDefined();
  expect(hooks.hooks.agentStop[0].bash).toBe(HOOK_COMMANDS.COPILOT_STOP);
  expect(hooks.hooks.agentStop[0].powershell).toBe(HOOK_COMMANDS.COPILOT_STOP);
});

test('does not create a userPromptTransformed hook by default', async () => {
  await runInitCopilot(tempDir);
  const hooks = JSON.parse(await readFile(path.join(tempDir, '.github', 'hooks', 'memory-anchor.json'), 'utf8'));
  expect(hooks.hooks.userPromptTransformed).toBeUndefined();
});

test('creates userPromptTransformed hook when Copilot is enabled', async () => {
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(
    path.join(tempDir, '.memoryanchor', 'prompt-hooks.json'),
    JSON.stringify({ enabled: ['copilot'] }) + '\n',
  );
  await runInitCopilot(tempDir);
  const hooks = JSON.parse(await readFile(path.join(tempDir, '.github', 'hooks', 'memory-anchor.json'), 'utf8'));
  expect(hooks.hooks.userPromptTransformed[0].bash).toBe(HOOK_COMMANDS.COPILOT_PROMPT);
});

test('creates .github/hooks/memory-anchor.json with sessionEnd hook', async () => {
  await runInitCopilot(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.github', 'hooks', 'memory-anchor.json'), 'utf8'),
  );
  expect(hooks.hooks.sessionEnd).toBeDefined();
  expect(hooks.hooks.sessionEnd[0].bash).toBe(HOOK_COMMANDS.COPILOT_POST);
  expect(hooks.hooks.sessionEnd[0].powershell).toBe(HOOK_COMMANDS.COPILOT_POST);
});

test('creates .github/hooks/memory-anchor.json with version 1', async () => {
  await runInitCopilot(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.github', 'hooks', 'memory-anchor.json'), 'utf8'),
  );
  expect(hooks.version).toBe(1);
});

test('creates .github/copilot-instructions.md with memory anchor line', async () => {
  await runInitCopilot(tempDir);

  const instructions = await readFile(
    path.join(tempDir, '.github', 'copilot-instructions.md'),
    'utf8',
  );
  expect(instructions).toContain(AGENTS_ANCHOR_LINE);
});

test('existing copilot-instructions.md content is preserved', async () => {
  const instructionsPath = path.join(tempDir, '.github', 'copilot-instructions.md');
  await mkdir(path.dirname(instructionsPath), { recursive: true });
  await writeFile(instructionsPath, '# My Custom Rules\n\nBe helpful.\n');

  await runInitCopilot(tempDir);

  const content = await readFile(instructionsPath, 'utf8');
  expect(content).toContain('# My Custom Rules');
  expect(content).toContain('Be helpful.');
  expect(content).toContain(AGENTS_ANCHOR_LINE);
});

test('re-running does not duplicate hooks', async () => {
  await runInitCopilot(tempDir);
  await runInitCopilot(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(tempDir, '.github', 'hooks', 'memory-anchor.json'), 'utf8'),
  );
  expect(hooks.hooks.sessionStart).toHaveLength(1);
  expect(hooks.hooks.userPromptTransformed).toBeUndefined();
  expect(hooks.hooks.agentStop).toHaveLength(1);
  expect(hooks.hooks.sessionEnd).toHaveLength(1);
});

test('re-running does not duplicate copilot-instructions.md anchor line', async () => {
  await runInitCopilot(tempDir);
  await runInitCopilot(tempDir);

  const instructions = await readFile(
    path.join(tempDir, '.github', 'copilot-instructions.md'),
    'utf8',
  );
  const escaped = AGENTS_ANCHOR_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'g');
  const matches = instructions.match(re);
  expect(matches).toHaveLength(1);
});
