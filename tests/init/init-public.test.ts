import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANCHOR_DIR_NAME,
  CHART_FILE_NAME,
  GITIGNORE_ENTRY,
  GUARDRAILS_DEFAULT_RULES,
  GUARDRAILS_FILE_NAME,
  PROJECT_STATE_FILE_NAME,
} from '../../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitPublic(cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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

test('creates guardrails.md with default rules', async () => {
  await runInitPublic(tempDir);

  const guardrails = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, GUARDRAILS_FILE_NAME), 'utf8');
  expect(guardrails).toContain(GUARDRAILS_DEFAULT_RULES[3]);
  expect(guardrails).toContain('At the start of every task, read ./.memoryanchor/chart/.../chart.md');
  expect(guardrails).toContain('If the agent has any uncertainty about the overall project structure');
  expect(guardrails).toContain('Do not rebuild a function');
});

test('creates project-state.md with module status and key decisions', async () => {
  await runInitPublic(tempDir);

  const projectState = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, PROJECT_STATE_FILE_NAME), 'utf8');
  expect(projectState).toContain('## Module Status');
  expect(projectState).toContain('## Key Decisions');
});

test('migrates legacy ballast and manifest files without losing their content', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then((fs) => fs.mkdir(anchorDir, { recursive: true }));
  await writeFile(
    path.join(anchorDir, 'ballast.md'),
    '- [ ] Preserve this repository-specific rule.\n',
  );
  await writeFile(
    path.join(anchorDir, 'manifest.md'),
    '## Module Status\n### migrated\n- status: Stable\n',
  );

  await runInitPublic(tempDir);

  await expect(readFile(path.join(anchorDir, 'ballast.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(anchorDir, 'manifest.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(anchorDir, GUARDRAILS_FILE_NAME), 'utf8'))
    .resolves.toContain('Preserve this repository-specific rule.');
  await expect(readFile(path.join(anchorDir, PROJECT_STATE_FILE_NAME), 'utf8'))
    .resolves.toContain('### migrated');
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
  expect(chart).toContain('## Entry Charts');
  expect(chart).toContain('Start with the entry chart closest to the task');
  expect(chart).toContain('Listed chart paths are authoritative');
});

test('re-running does not duplicate guardrails', async () => {
  await runInitPublic(tempDir);
  await runInitPublic(tempDir);

  const guardrails = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, GUARDRAILS_FILE_NAME), 'utf8');
  const matches = guardrails.split('\n').filter(l => l === GUARDRAILS_DEFAULT_RULES[3]);
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
