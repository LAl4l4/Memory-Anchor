import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANCHOR_DIR_NAME, BALLAST_FILE_NAME } from '../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInit(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('init creates ballast with default rule', async () => {
  await runInit(tempDir);

  const ballastPath = path.join(tempDir, ANCHOR_DIR_NAME, BALLAST_FILE_NAME);
  const ballast = await readFile(ballastPath, 'utf8');

  expect(ballast).toContain('- [ ] Follow AGENTS.md rules.');
});
