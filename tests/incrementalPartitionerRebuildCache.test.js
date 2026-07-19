import { afterEach, expect, jest, test } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const updatePartitionChartContent = jest.fn(async () => ({
  changed: true,
  previousChars: 100,
  currentChars: 200
}));
const rebuildPartitionBoundary = jest.fn(async () => []);

jest.unstable_mockModule(
  '../dist/chartBuild/chartBuildHelper/partitionChartIncrementalUpdater.js',
  () => ({ updatePartitionChartContent })
);
jest.unstable_mockModule(
  '../dist/chartBuild/chartPartitioner/partitionedChartBuilder.js',
  () => ({ rebuildPartitionBoundary })
);

const { updatePartitionedChartsIncrementally } = await import(
  '../dist/chartBuild/chartPartitioner/incrementalPartitioner.js'
);

let tempDir = '';

afterEach(async () => {
  updatePartitionChartContent.mockClear();
  rebuildPartitionBoundary.mockClear();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

test('files under a rebuilt directory skip the remaining incremental work', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-rebuild-cache-'));
  const anchorDir = path.join(tempDir, '.memoryanchor');
  const chartDir = path.join(anchorDir, 'chart');
  await mkdir(chartDir, { recursive: true });
  await writeFile(path.join(anchorDir, 'index.md'), '# index\n', 'utf8');
  await writeFile(path.join(chartDir, 'chart.md'), '# chart\n', 'utf8');
  await writeFile(
    path.join(anchorDir, 'dirTree.json'),
    `${JSON.stringify({
      directory: '.',
      parent: null,
      children: [],
      thisDirectoryChars: 100,
      isSplit: false
    })}\n`,
    'utf8'
  );

  const updated = await updatePartitionedChartsIncrementally(
    ['first.ts', 'second.ts'],
    {
      projectRoot: tempDir,
      thresholds: { splitAt: 150, mergeAt: 50 }
    }
  );

  expect(updated).toBe(true);
  expect(updatePartitionChartContent).toHaveBeenCalledTimes(1);
  expect(rebuildPartitionBoundary).toHaveBeenCalledTimes(1);
});
