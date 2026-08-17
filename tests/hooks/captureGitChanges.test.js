import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { captureGitChanges } from '../../dist/utils/captureGitChanges.js';

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
