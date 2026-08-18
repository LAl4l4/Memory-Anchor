import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { USER_PROMPT_APPENDIX } from '../../dist/hooks/public/userPromptAppend.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');
const originalCwd = process.cwd();

let tempDir = '';

function runHook(relativePath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'dist', relativePath)], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Hook failed (${code}): ${stderr}`));
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-hermes-hooks-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('pre-llm-call injects the memory core as context in a workspace', async () => {
  await mkdir(path.join(tempDir, '.memoryanchor', 'chart'), { recursive: true });
  await writeFile(path.join(tempDir, '.memoryanchor', 'index.md'), '# chart index\n');

  const output = JSON.parse(await runHook('hooks/hermes/pre-llm-call.js', tempDir));
  expect(output.context).toContain('[MEMORY ANCHOR: CONTEXT INJECTED]');
  expect(output.context).toContain('# chart index');
});

test('pre-llm-call is a silent no-op outside a Memory Anchor workspace', async () => {
  expect(await runHook('hooks/hermes/pre-llm-call.js', tempDir)).toBe('{}');
});

test('user-prompt appends the reminder as context in a workspace', async () => {
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(path.join(tempDir, '.memoryanchor', 'index.md'), '# chart index\n');

  const output = JSON.parse(await runHook('hooks/hermes/user-prompt.js', tempDir));
  expect(output.context).toContain(USER_PROMPT_APPENDIX);
});

test('user-prompt is a silent no-op outside a Memory Anchor workspace', async () => {
  expect(await runHook('hooks/hermes/user-prompt.js', tempDir)).toBe('{}');
});

test('stop and session-end exit cleanly outside a Memory Anchor workspace', async () => {
  await runHook('hooks/hermes/stop.js', tempDir);
  await runHook('hooks/hermes/session-end.js', tempDir);
});