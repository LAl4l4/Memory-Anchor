import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEBUG_CONFIG_FILE_NAME,
  DEBUG_LOG_FILE_NAME,
} from '../../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

let tempDir = '';

interface CliResult {
  error: Error | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise<CliResult>(resolve => {
    execFile(process.execPath, [cliPath, ...args], { cwd: tempDir }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-debug-'));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('debug command enables persistent logging without requiring full initialization', async () => {
  const result = await runCli(['debug']);

  expect(result.error).toBeNull();
  expect(result.stdout).toContain('Memory Anchor debug logging enabled');

  const config = JSON.parse(await readFile(
    path.join(tempDir, '.memoryanchor', DEBUG_CONFIG_FILE_NAME),
    'utf8',
  ));
  expect(config).toEqual({ enabled: true });

  const log = await readFile(path.join(tempDir, '.memoryanchor', DEBUG_LOG_FILE_NAME), 'utf8');
  expect(log).toContain('[INFO] Memory Anchor debug logging enabled');
});

test('enabled debug mode mirrors CLI output and records command failures', async () => {
  await runCli(['debug']);
  const status = await runCli(['status']);
  const unknown = await runCli(['not-a-command']);

  expect(status.error).toBeNull();
  expect(unknown.error).not.toBeNull();

  const log = await readFile(path.join(tempDir, '.memoryanchor', DEBUG_LOG_FILE_NAME), 'utf8');
  expect(log).toContain('MemoryAnchor v');
  expect(log).toContain('Status:     Not initialized');
  expect(log).toContain('Unknown command: not-a-command');
});

test('debug --off stops appending while preserving the existing log', async () => {
  await runCli(['debug']);
  const logPath = path.join(tempDir, '.memoryanchor', DEBUG_LOG_FILE_NAME);
  const beforeDisable = await readFile(logPath, 'utf8');

  const disabled = await runCli(['debug', '--off']);
  await runCli(['status']);

  expect(disabled.error).toBeNull();
  expect(disabled.stdout).toContain('Memory Anchor debug logging disabled');
  expect(JSON.parse(await readFile(
    path.join(tempDir, '.memoryanchor', DEBUG_CONFIG_FILE_NAME),
    'utf8',
  ))).toEqual({ enabled: false });
  await expect(readFile(logPath, 'utf8')).resolves.toBe(beforeDisable);
});
