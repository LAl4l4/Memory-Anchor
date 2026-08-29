import { expect, jest, test } from '@jest/globals';

const updatePartitionedChartsIncrementally = jest.fn(async () => true);
const buildPartitionedCharts = jest.fn(async () => ({
  directories: ['.'],
  chartPaths: ['.memoryanchor/chart/chart.md'],
  indexPath: '.memoryanchor/index.md'
}));

jest.unstable_mockModule(
  '../../dist/chartBuild/partition/incrementalPartitioner.js',
  () => ({ updatePartitionedChartsIncrementally })
);
jest.unstable_mockModule(
  '../../dist/chartBuild/partition/partitionedChartBuilder.js',
  () => ({ buildPartitionedCharts })
);

const {
  updateChartIncrementally,
  updatePartitionedChartIncrementally
} = await import('../../dist/chartBuild/incremental.js');

test('the legacy incremental entry points to the partitioned updater', async () => {
  expect(updateChartIncrementally).toBe(updatePartitionedChartIncrementally);

  await updateChartIncrementally(['src/index.ts']);

  expect(updatePartitionedChartsIncrementally).toHaveBeenCalledWith(['src/index.ts']);
  expect(buildPartitionedCharts).not.toHaveBeenCalled();
});
