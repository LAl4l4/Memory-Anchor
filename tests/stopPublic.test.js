import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


const originalCwd = process.cwd();

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-stoppublic-'));
  process.chdir(tempDir);
  jest.resetModules();
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function initGitRepo() {
  execSync('git init', { cwd: tempDir });
  execSync('git config user.email "test@test.com"', { cwd: tempDir });
  execSync('git config user.name "Test"', { cwd: tempDir });
}

test('runStop do nothing when no git changes (clean repo)', async () => {
  initGitRepo();

  // Mock the chart module before importing stopPublic so its imports are mocked
  jest.unstable_mockModule('../dist/chartBuild/build-chart.js', () => ({
    buildChartFull: jest.fn(async () => {}),
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  jest.spyOn(process, 'exit').mockImplementation(() => {});

  const stopModule = await import('../dist/hooks/public/stopPublic.js');
  const buildChart = await import('../dist/chartBuild/build-chart.js');

  await stopModule.runStop();

  expect(buildChart.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledWith(0);

  process.exit.mockRestore();
});

test('runStop calls the partitioned incremental updater when there are git changes', async () => {
  initGitRepo();

  await writeFile(path.join(tempDir, 'a.ts'), 'export const a = 1;');
  await writeFile(path.join(tempDir, 'b.ts'), 'export const b = 1;');
  execSync('git add a.ts b.ts');
  execSync('git commit -m "initial"');
  await writeFile(path.join(tempDir, 'a.ts'), 'export const a = 2;');

  jest.unstable_mockModule('../dist/chartBuild/build-chart.js', () => ({
    buildChartFull: jest.fn(async () => {}),
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  jest.spyOn(process, 'exit').mockImplementation(() => {});

  const stopModule = await import('../dist/hooks/public/stopPublic.js');
  const buildChart = await import('../dist/chartBuild/build-chart.js');

  await stopModule.runStop();

  expect(buildChart.updatePartitionedChartIncrementally).toHaveBeenCalledTimes(1);
  const arg = buildChart.updatePartitionedChartIncrementally.mock.calls[0][0];
  expect(arg).toContain('a.ts');
  expect(buildChart.buildChartFull).not.toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledWith(0);

  process.exit.mockRestore();
});

test('runStop do nothing when no git repo exists (captureGitChanges returns null)', async () => {
  jest.unstable_mockModule('../dist/chartBuild/build-chart.js', () => ({
    buildChartFull: jest.fn(async () => {}),
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  jest.spyOn(process, 'exit').mockImplementation(() => {});

  const stopModule = await import('../dist/hooks/public/stopPublic.js');
  const buildChart = await import('../dist/chartBuild/build-chart.js');

  await stopModule.runStop();

  expect(buildChart.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledWith(0);

  process.exit.mockRestore();
});
