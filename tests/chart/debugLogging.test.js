import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();

let tempDir = '';
let updatePartitionedChartsIncrementally;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-debug-incremental-'));
  process.chdir(tempDir);
  jest.resetModules();

  const { setDebugMode } = await import('../../dist/utils/logger.js');
  setDebugMode(tempDir, true);
  ({ updatePartitionedChartsIncrementally } = await import(
    '../../dist/chartBuild/partition/incrementalPartitioner.js'
  ));
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('records the missing persistent state that requires an incremental fallback', async () => {
  await expect(updatePartitionedChartsIncrementally(['src/example.ts'])).resolves.toBe(false);

  const log = await readFile(path.join(tempDir, '.memoryanchor', 'debug.log'), 'utf8');
  expect(log).toContain('Incremental topology unavailable: missing dirTree.json, index.md.');
});
