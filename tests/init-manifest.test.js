import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('init creates manifest with empty todo and done sections', async () => {
  await runInit(tempDir);

  const manifestPath = path.join(tempDir, '.memoryanchor', 'manifest.md');
  const manifest = await readFile(manifestPath, 'utf8');

  expect(manifest).toContain('## Todo:');
  expect(manifest).toContain('## Done:');
});
