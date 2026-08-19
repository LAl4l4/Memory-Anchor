import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { captureGitChanges } from '../../dist/utils/captureGitChanges.js';
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

  expect(captureGitChanges()).toEqual(expect.arrayContaining([
    { status: 'D', file: watchedPath }
  ]));
  await expect(readFile(watchPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
