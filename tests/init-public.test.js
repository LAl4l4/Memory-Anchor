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

function runInitClaude(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-claude'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-public-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .memoryanchor directory', async () => {
  await runInitClaude(tempDir);

  const anchorDir = path.join(tempDir, '.memoryanchor');
  const stat = await import('node:fs/promises').then((fs) => fs.stat(anchorDir));
  expect(stat.isDirectory()).toBe(true);
});

test('creates .gitignore with .memoryanchor entry', async () => {
  await runInitClaude(tempDir);

  const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
  expect(gitignore).toContain('.memoryanchor');
});

test('creates ballast.md with default rules', async () => {
  await runInitClaude(tempDir);

  const ballast = await readFile(path.join(tempDir, '.memoryanchor', 'ballast.md'), 'utf8');
  expect(ballast).toContain('- [ ] Follow AGENTS.md rules.');
  expect(ballast).toContain('- [ ] Do not repeat yourself.');
});

test('creates manifest.md with Todo and Done sections', async () => {
  await runInitClaude(tempDir);

  const manifest = await readFile(path.join(tempDir, '.memoryanchor', 'manifest.md'), 'utf8');
  expect(manifest).toContain('## Todo:');
  expect(manifest).toContain('## Done:');
});

test('creates AGENTS.md with memory anchor rules', async () => {
  await runInitClaude(tempDir);

  const agents = await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('## Memory Anchor Rules');
  expect(agents).toContain('## Memory Anchor Ends');
});

test('creates and populates chart.md', async () => {
  await runInitClaude(tempDir);

  const chart = await readFile(path.join(tempDir, '.memoryanchor', 'chart.md'), 'utf8');
  expect(chart).toContain('# PROJECT CHART');
});

test('re-running does not duplicate ballast rules', async () => {
  await runInitClaude(tempDir);
  await runInitClaude(tempDir);

  const ballast = await readFile(path.join(tempDir, '.memoryanchor', 'ballast.md'), 'utf8');
  const matches = ballast.match(/Follow AGENTS\.md rules\./g);
  expect(matches).toHaveLength(1);
});

test('re-running does not duplicate .gitignore entry', async () => {
  await runInitClaude(tempDir);
  await runInitClaude(tempDir);

  const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
  const lines = gitignore.split('\n').filter((l) => l.trim() === '.memoryanchor');
  expect(lines).toHaveLength(1);
});
