import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFileSync, execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acknowledgeGitChanges, captureGitChanges } from '../../dist/utils/captureGitChanges.js';
import { UNTRACKED_FILE_WATCH_FILE_NAME } from '../../dist/constant.js';

const originalCwd = process.cwd();
let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-capture-git-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function initGitRepo() {
  execSync('git init', { cwd: tempDir });
  execSync('git config user.email "test@test.com"', { cwd: tempDir });
  execSync('git config user.name "Test"', { cwd: tempDir });
}

test('captureGitChanges expands multiple new untracked directories into file paths', async () => {
  initGitRepo();

  await writeFile(path.join(tempDir, 'README.md'), '# baseline\n');
  execSync('git add README.md');
  execSync('git commit -m "initial"');

  const newFiles = [
    'src/feature-a/entry.ts',
    'src/feature-b/nested/entry.ts',
    'src/feature-c/entry.ts',
  ];
  for (const relativePath of newFiles) {
    const absolutePath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `export const value = '${relativePath}';\n`);
  }

  const changes = captureGitChanges();
  const changedPaths = changes?.map(change => change.file) ?? [];

  expect(changes).toHaveLength(newFiles.length);
  expect(changedPaths).toEqual(expect.arrayContaining(newFiles));
  expect(changedPaths).not.toEqual(expect.arrayContaining([
    'src/feature-a',
    'src/feature-b',
    'src/feature-c',
  ]));
  expect(changes?.every(change => change.status === '??')).toBe(true);
});

test('reports deletion of a previously observed untracked file', async () => {
  initGitRepo();

  const watchedPath = 'src/untracked.ts';
  await mkdir(path.join(tempDir, 'src'));
  await writeFile(path.join(tempDir, watchedPath), 'export const value = 1;\n');

  expect(captureGitChanges()).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: '??', file: watchedPath })
  ]));
  const watchPath = path.join(
    tempDir,
    '.memoryanchor',
    UNTRACKED_FILE_WATCH_FILE_NAME
  );
  await expect(readFile(watchPath, 'utf8')).resolves.toContain(watchedPath);

  await rm(path.join(tempDir, watchedPath));

  const deletion = [{ status: 'D', file: watchedPath }];
  expect(captureGitChanges()).toEqual(deletion);
  // Capture is not a successful refresh: keep reporting until acknowledged.
  expect(captureGitChanges()).toEqual(deletion);
  await expect(readFile(watchPath, 'utf8')).resolves.toContain(watchedPath);
  acknowledgeGitChanges(deletion);
  expect(captureGitChanges()).toBeNull();
  await expect(readFile(watchPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('preserves whitespace, Unicode, quotes and literal backslashes in Git paths', async () => {
  initGitRepo();
  const files = ['with space.ts', '中文.ts', 'tab\tname.ts', 'line\nbreak.ts', '"quoted".ts'];
  if (process.platform !== 'win32') files.push('back\\slash.ts');
  for (const file of files) await writeFile(path.join(tempDir, file), 'export const value = 1;');
  expect(captureGitChanges()).toEqual(expect.arrayContaining(
    files.map(file => ({ status: '??', file })),
  ));
  execFileSync('git', ['add', '--all']);
  execFileSync('git', ['commit', '-qm', 'initial']);
  for (const file of files) await writeFile(path.join(tempDir, file), 'export const value = 2;');
  const changes = captureGitChanges();
  expect(changes).toHaveLength(files.length);
  expect(changes).toEqual(expect.arrayContaining(files.map(file => ({ status: 'M', file }))));
});

test('captures both sides of a rename without consuming the following change', async () => {
  initGitRepo();
  await writeFile('old 中文.ts', 'export const value = 1;');
  execFileSync('git', ['add', '--all']);
  execFileSync('git', ['commit', '-qm', 'initial']);
  execFileSync('git', ['mv', '--', 'old 中文.ts', 'new name.ts']);
  await writeFile('z.ts', 'export const z = 1;');
  expect(captureGitChanges()).toEqual(expect.arrayContaining([
    { status: 'R', file: 'new name.ts' },
    { status: 'D', file: 'old 中文.ts' },
    { status: '??', file: 'z.ts' },
  ]));
});

test('acknowledging a deletion does not forget a file recreated before acknowledgement', async () => {
  initGitRepo();
  await writeFile('recreated.ts', 'export const value = 1;');
  captureGitChanges();
  await rm('recreated.ts');
  const deletion = captureGitChanges()!;
  await writeFile('recreated.ts', 'export const value = 2;');
  acknowledgeGitChanges(deletion);
  await rm('recreated.ts');
  expect(captureGitChanges()).toEqual([{ status: 'D', file: 'recreated.ts' }]);
});

test('stops watching an untracked file after it enters the Git index', async () => {
  initGitRepo();

  const watchedPath = 'src/tracked-later.ts';
  await mkdir(path.join(tempDir, 'src'));
  await writeFile(path.join(tempDir, watchedPath), 'export const value = 1;\n');
  captureGitChanges();

  execSync(`git add ${watchedPath}`, { cwd: tempDir });
  expect(captureGitChanges()).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: watchedPath })
  ]));

  await expect(readFile(path.join(
    tempDir,
    '.memoryanchor',
    UNTRACKED_FILE_WATCH_FILE_NAME
  ), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
