import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GITIGNORE_ENTRY, ANCHOR_DIR_NAME, CHART_FILE_NAME, BALLAST_FILE_NAME, MANIFEST_FILE_NAME, BALLAST_DEFAULT_RULES } from '../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitPublic(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-public'], { cwd }, (error) => {
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
  await runInitPublic(tempDir);

  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  const stat = await import('node:fs/promises').then((fs) => fs.stat(anchorDir));
  expect(stat.isDirectory()).toBe(true);
});

test('creates .gitignore with .memoryanchor entry', async () => {
  await runInitPublic(tempDir);

  const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
  expect(gitignore).toContain(ANCHOR_DIR_NAME);
});

test('creates ballast.md with default rules', async () => {
  await runInitPublic(tempDir);

  const ballast = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, BALLAST_FILE_NAME), 'utf8');
  expect(ballast).toContain(BALLAST_DEFAULT_RULES[3]);
  expect(ballast).toContain('At the start of every task, read ./.memoryanchor/chart/.../chart.md');
  expect(ballast).toContain('If the agent has any uncertainty about the overall project structure');
  expect(ballast).toContain('Do not rebuild a function');
});

test('creates manifest.md with module status and key decisions', async () => {
  await runInitPublic(tempDir);

  const manifest = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, MANIFEST_FILE_NAME), 'utf8');
  expect(manifest).toContain('## Module Status');
  expect(manifest).toContain('## Key Decisions');
});

test('creates AGENTS.md with memory anchor rules', async () => {
  await runInitPublic(tempDir);

  const agents = await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('## Memory Anchor Rules');
  expect(agents).toContain('## Memory Anchor Ends');
  expect(agents).toContain('./.memoryanchor/chart/.../chart.md: Directory-level architecture map.');
  expect(agents).toContain('At the start of every task, read ./.memoryanchor/chart/.../chart.md');
  expect(agents).toContain('If the agent has any uncertainty about the overall project structure');
  expect(agents).toContain('read the closest matching directory chart listed there');
  expect(agents).toContain('## Chart Relationship Notation');
  expect(agents).toContain("'+' marks an exported symbol; '-' marks the default/internal symbol");
  expect(agents).toContain("'->' lists parseable repository files referenced by a file, including targets in full repository.");
  expect(agents).toContain(
    "'<-' lists import-resolved cross-file callers (across charts in full builds), never same-file, member, or dynamic calls; it is attached only to symbols."
  );
});

test('upgrades the managed AGENTS.md block while preserving other instructions', async () => {
  const agentsPath = path.join(tempDir, 'AGENTS.md');
  await writeFile(agentsPath, `# Project Rules

Keep this custom instruction.

## Memory Anchor Rules
Old generated content.
- Always read ./.memoryanchor/chart.md before accessing any repository files. Only open repository files when chart.md is insufficient.
## Memory Anchor Ends

# Trailing Rules
Preserve this too.
`);

  await runInitPublic(tempDir);

  const agents = await readFile(agentsPath, 'utf8');
  expect(agents).toContain('Keep this custom instruction.');
  expect(agents).toContain('Preserve this too.');
  expect(agents).toContain('At the start of every task, read ./.memoryanchor/chart/.../chart.md');
  expect(agents).toContain('If the agent has any uncertainty about the overall project structure');
  expect(agents.match(/## Memory Anchor Rules/g)).toHaveLength(1);
});

test('creates and populates the partitioned chart index', async () => {
  await runInitPublic(tempDir);

  const chart = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, CHART_FILE_NAME), 'utf8');
  expect(chart).toContain('# Project Chart Index');
  expect(chart).toContain('## Root Partitions');
  expect(chart).toContain('How to find the right chart:');
  expect(chart).toContain('A non-split frontier');
});

test('re-running does not duplicate ballast rules', async () => {
  await runInitPublic(tempDir);
  await runInitPublic(tempDir);

  const ballast = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, BALLAST_FILE_NAME), 'utf8');
  const matches = ballast.split('\n').filter(l => l === BALLAST_DEFAULT_RULES[3]);
  expect(matches).toHaveLength(1);
});

test('re-running does not duplicate .gitignore entries', async () => {
  await runInitPublic(tempDir);
  await runInitPublic(tempDir);

  const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
  GITIGNORE_ENTRY.forEach((entry) => {
    const lines = gitignore.split('\n').filter((l) => l.trim() === entry);
    expect(lines).toHaveLength(1);
  });
});
