import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARDRAILS_MAX_BYTES } from '../../dist/constant.js';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ma-maintain-'));
  await mkdir(path.join(directory, '.memoryanchor'));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test('maintenance reports budgets and legacy markers without rewriting memory', async () => {
  const guardrails = `# Repository-specific Guardrails\n- [ ] ${'x'.repeat(GUARDRAILS_MAX_BYTES)} [STALE]\n`;
  const target = path.join(directory, '.memoryanchor', 'guardrails.md');
  await writeFile(target, guardrails);
  const output = execFileSync(process.execPath, [cli, 'maintain'], { cwd: directory, encoding: 'utf8' });
  expect(output).toContain('[MEMORY MAINTENANCE NOTICE]');
  expect(output).toContain('legacy [STALE] markers');
  expect(output).not.toContain('Your Action Required');
  expect(await readFile(target, 'utf8')).toBe(guardrails);
});

test('only explicit normalization changes formatting and preserves legacy rules for review', async () => {
  const target = path.join(directory, '.memoryanchor', 'guardrails.md');
  await writeFile(target, '# Repository-specific Guardrails\n* Keep important constraint [STALE]\n');
  execFileSync(process.execPath, [cli, 'maintain', '--normalize'], { cwd: directory });
  expect(await readFile(target, 'utf8')).toContain('- [ ] Keep important constraint [STALE]');
});
