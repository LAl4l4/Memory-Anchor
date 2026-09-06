import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acknowledgeGitChanges, captureGitChanges } from '../../dist/utils/captureGitChanges.js';

const originalCwd = process.cwd();
let directory: string;
const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' });

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ma-refresh-checkpoint-'));
  process.chdir(directory);
  git('init', '-q');
  await writeFile('file.ts', 'export const value = 1;');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(directory, { recursive: true, force: true });
});

test('skips successfully refreshed dirty files across processes and staging changes', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  const changes = captureGitChanges()!;
  acknowledgeGitChanges(changes);
  expect(captureGitChanges()).toBeNull();
  git('add', 'file.ts');
  expect(captureGitChanges()).toBeNull();
  const moduleUrl = new URL('../../dist/utils/captureGitChanges.js', import.meta.url).href;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { captureGitChanges } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(captureGitChanges()));`,
  ], { encoding: 'utf8' });
  expect(result.trim()).toBe('null');
  await writeFile('file.ts', 'export const value = 3;');
  expect(captureGitChanges()?.map(change => change.file)).toEqual(['file.ts']);
});

test('captures a revert even when git status becomes clean', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  acknowledgeGitChanges(captureGitChanges()!);
  git('restore', 'file.ts');
  expect(git('status', '--porcelain').toString()).toContain('.memoryanchor/');
  const reverted = captureGitChanges()!;
  expect(reverted).toEqual([{ status: 'M', file: 'file.ts' }]);
  acknowledgeGitChanges(reverted);
  expect(captureGitChanges()).toBeNull();
});

test('does not acknowledge edits that occur while a refresh is running', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  const captured = captureGitChanges()!;
  await writeFile('file.ts', 'export const value = 3;');
  acknowledgeGitChanges(captured);
  expect(captureGitChanges()?.map(change => change.file)).toEqual(['file.ts']);
});

test('forces one retry after an edit during refresh, then deduplicates normally', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  const captured = captureGitChanges()!;
  await writeFile('file.ts', 'export const value = 3;');
  acknowledgeGitChanges(captured);
  const retry = captureGitChanges()!;
  expect(retry).toEqual([{ status: 'M', file: 'file.ts' }]);
  acknowledgeGitChanges(retry);
  expect(captureGitChanges()).toBeNull();
});

test('retries a revert during rendering even though the path becomes Git-clean', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  const captured = captureGitChanges()!;
  git('restore', 'file.ts');
  acknowledgeGitChanges(captured);
  const reverted = captureGitChanges()!;
  expect(reverted).toEqual([{ status: 'M', file: 'file.ts' }]);
  acknowledgeGitChanges(reverted);
  expect(captureGitChanges()).toBeNull();
});

test('an unsuccessful refresh does not suppress retries', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  expect(captureGitChanges()).toEqual(captureGitChanges());
  acknowledgeGitChanges(captureGitChanges()!);
  await rm('file.ts');
  expect(captureGitChanges()).toEqual([{ status: 'D', file: 'file.ts' }]);
  expect(captureGitChanges()).toEqual([{ status: 'D', file: 'file.ts' }]);
  acknowledgeGitChanges(captureGitChanges()!);
  expect(captureGitChanges()).toBeNull();
});

test('keeps unchanged files checkpointed when another refresh rewrites graph artifacts', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  acknowledgeGitChanges(captureGitChanges()!);
  await writeFile('other.ts', 'export const other = 1;');
  const changes = captureGitChanges()!;
  expect(changes.map(change => change.file)).toEqual(['other.ts']);
  await writeFile('.memoryanchor/dependencyGraph.json', '{}');
  acknowledgeGitChanges(changes);
  expect(captureGitChanges()).toBeNull();
});

test('invalidates a checkpoint when chart state is externally replaced or checkpoint is corrupt', async () => {
  await writeFile('file.ts', 'export const value = 2;');
  acknowledgeGitChanges(captureGitChanges()!);
  await writeFile('.memoryanchor/dirTree.json', '{}');
  expect(captureGitChanges()?.map(change => change.file)).toEqual(['file.ts']);
  acknowledgeGitChanges(captureGitChanges()!);
  await writeFile('.memoryanchor/refresh-checkpoint.json', 'invalid');
  expect(captureGitChanges()?.map(change => change.file)).toEqual(['file.ts']);
});

test('unchanged untracked files skip refresh but remain watched for deletion', async () => {
  await mkdir('new');
  for (let index = 0; index < 30; index++) await writeFile(`new/${index}.ts`, 'export const value = 1;');
  acknowledgeGitChanges(captureGitChanges()!);
  expect(captureGitChanges()).toBeNull();
  await rm('new/10.ts');
  const deleted = captureGitChanges()!;
  expect(deleted).toEqual([{ status: 'D', file: 'new/10.ts' }]);
  acknowledgeGitChanges(deleted);
  expect(captureGitChanges()).toBeNull();
});
