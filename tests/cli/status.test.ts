import { realpathSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANCHOR_DIR_NAME,
  CHART_FILE_NAME,
  GUARDRAILS_FILE_NAME,
  PROJECT_STATE_FILE_NAME,
} from '../../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runStatus(cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'status'], { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-status-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('shows version number in output', async () => {
  const stdout = await runStatus(tempDir);
  expect(stdout).toMatch(/MemoryAnchor v\d+\.\d+\.\d+/);
});

test('shows Not initialized status when no anchor files exist', async () => {
  const stdout = await runStatus(tempDir);
  expect(stdout).toContain('Status:     Not initialized');
});

test('shows Active status when all anchor files exist', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await mkdir(anchorDir, { recursive: true });
  await writeFile(path.join(anchorDir, CHART_FILE_NAME), '# chart');
  await writeFile(path.join(anchorDir, GUARDRAILS_FILE_NAME), '- [ ] rule');
  await writeFile(path.join(anchorDir, PROJECT_STATE_FILE_NAME), '## Todo');

  const stdout = await runStatus(tempDir);
  expect(stdout).toContain('Status:     Active');
});

test('shows Partial status when only some anchor files exist', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await mkdir(anchorDir, { recursive: true });
  await writeFile(path.join(anchorDir, CHART_FILE_NAME), '# chart');

  const stdout = await runStatus(tempDir);
  expect(stdout).toContain('Status:     Partial');
});

test('shows CWD matching the working directory', async () => {
  const stdout = await runStatus(tempDir);
  expect(stdout).toContain('CWD:        ' + realpathSync(tempDir));
});

test('shows dataDir and indexDir from config', async () => {
  const stdout = await runStatus(tempDir);
  expect(stdout).toContain(`Data Dir:   ${ANCHOR_DIR_NAME}`);
  expect(stdout).toContain(`Index Dir:  ${ANCHOR_DIR_NAME}/index`);
});

test('shows index.md, guardrails.md, and project-state.md with check/cross marks', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await mkdir(anchorDir, { recursive: true });
  await writeFile(path.join(anchorDir, CHART_FILE_NAME), '# chart');

  const stdout = await runStatus(tempDir);

  // index.md should have a check mark (exists)
  expect(stdout).toMatch(/index\.md\s+✓/);

  // guardrails.md and project-state.md should have cross marks (missing)
  expect(stdout).toMatch(/guardrails\.md\s+✗/);
  expect(stdout).toMatch(/project-state\.md\s+✗/);
});
