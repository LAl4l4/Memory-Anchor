import { afterEach, expect, jest, test } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const updatePartitionChartContent = jest.fn(async () => ({
  changed: true,
  previousChars: 100,
  currentChars: 200
}));
const buildPartitionedCharts = jest.fn(async () => ({
  directories: ['.'],
  chartPaths: [],
  indexPath: ''
}));
const rebuildPartitionBoundary = jest.fn(async () => []);
const captureChartTopology = jest.fn(() => ({
  directories: ['.'],
  shallowDirectories: new Set(),
  chartChildren: new Map(),
  rootDirectories: ['.']
}));

jest.unstable_mockModule(
  '../dist/chartBuild/chartBuildHelper/partitionChartIncrementalUpdater.js',
  () => ({ updatePartitionChartContent })
);
jest.unstable_mockModule(
  '../dist/chartBuild/chartPartitioner/partitionedChartBuilder.js',
  () => ({ buildPartitionedCharts, captureChartTopology, rebuildPartitionBoundary })
);

const { updatePartitionedChartsIncrementally } = await import(
  '../dist/chartBuild/chartPartitioner/incrementalPartitioner.js'
);

let tempDir = '';

afterEach(async () => {
  updatePartitionChartContent.mockClear();
  buildPartitionedCharts.mockClear();
  rebuildPartitionBoundary.mockClear();
  captureChartTopology.mockClear();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

test('a direct-file ownership change rebuilds chart topology once for the batch', async () => {
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
      hasDirectFiles: false,
      thisDirectoryChars: 100,
      isSplit: false
    })}\n`,
    'utf8'
  );
  await writeFile(path.join(tempDir, 'first.ts'), 'export const first = 1;\n', 'utf8');
  await writeFile(path.join(tempDir, 'second.ts'), 'export const second = 2;\n', 'utf8');

  const updated = await updatePartitionedChartsIncrementally(
    ['first.ts', 'second.ts'],
    {
      projectRoot: tempDir,
      thresholds: { splitAt: 150, mergeAt: 50 }
    }
  );

  expect(updated).toBe(true);
  expect(updatePartitionChartContent).not.toHaveBeenCalled();
  expect(buildPartitionedCharts).toHaveBeenCalledTimes(1);
});
