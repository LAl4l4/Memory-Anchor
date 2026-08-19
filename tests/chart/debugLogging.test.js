import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();

let tempDir = '';
let updatePartitionedChartsIncrementally;
let buildPartitionedChartsForDebug;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-debug-incremental-'));
  process.chdir(tempDir);
  jest.resetModules();

  const { setDebugMode } = await import('../../dist/utils/logger.js');
  setDebugMode(tempDir, true);
  ({ updatePartitionedChartsIncrementally } = await import(
    '../../dist/chartBuild/partition/incrementalPartitioner.js'
  ));
  ({ buildPartitionedChartsForDebug } = await import(
    '../../dist/chartBuild/partition/partitionedChartBuilder.js'
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

test('reports the actual rendered and removed chart counts', async () => {
  await writeFile(
    path.join(tempDir, 'index.ts'),
    'export const initial = 1;\n',
    'utf8'
  );
  const thresholds = { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 };
  await buildPartitionedChartsForDebug({ projectRoot: tempDir, thresholds });

  await writeFile(
    path.join(tempDir, 'index.ts'),
    'export const updated = 1;\n',
    'utf8'
  );
  await expect(updatePartitionedChartsIncrementally(['index.ts'], {
    projectRoot: tempDir,
    thresholds
  })).resolves.toBe(true);

  const log = await readFile(path.join(tempDir, '.memoryanchor', 'debug.log'), 'utf8');
  expect(log).toContain(
    'Incremental partition pipeline completed: rendered 1 chart(s), removed 0 obsolete chart(s); topology changed: false.'
  );
});
