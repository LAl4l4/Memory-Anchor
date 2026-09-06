import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';


const originalCwd = process.cwd();

let tempDir = '';

function mockProcessExit() {
  return jest.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
}

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

  // Mock the incremental module before importing stopPublic so its imports are mocked
  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  const exitSpy = mockProcessExit();

  const stopModule = await import('../../dist/hooks/public/stopPublic.js');
  const incremental = await import('../../dist/chartBuild/incremental.js');

  await stopModule.runStop();

  expect(incremental.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(exitSpy).toHaveBeenCalledWith(0);

  exitSpy.mockRestore();
});

test('runStop calls the partitioned incremental updater when there are git changes', async () => {
  initGitRepo();

  await writeFile(path.join(tempDir, 'a.ts'), 'export const a = 1;');
  await writeFile(path.join(tempDir, 'b.ts'), 'export const b = 1;');
  execSync('git add a.ts b.ts');
  execSync('git commit -m "initial"');
  await writeFile(path.join(tempDir, 'a.ts'), 'export const a = 2;');

  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  const exitSpy = mockProcessExit();

  const stopModule = await import('../../dist/hooks/public/stopPublic.js');
  const incremental = await import('../../dist/chartBuild/incremental.js');

  await stopModule.runStop();

  const updateIncrementally = incremental.updatePartitionedChartIncrementally as jest.MockedFunction<
    typeof incremental.updatePartitionedChartIncrementally
  >;
  expect(updateIncrementally).toHaveBeenCalledTimes(1);
  const arg = updateIncrementally.mock.calls[0][0];
  expect(arg).toContain('a.ts');
  expect(exitSpy).toHaveBeenCalledWith(0);

  exitSpy.mockRestore();
});

test('runStop forwards a watched untracked-file deletion to the incremental updater', async () => {
  initGitRepo();
  const watchedPath = path.join(tempDir, 'watched.ts');
  await writeFile(watchedPath, 'export const watched = 1;');

  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  const exitSpy = mockProcessExit();

  const stopModule = await import('../../dist/hooks/public/stopPublic.js');
  const incremental = await import('../../dist/chartBuild/incremental.js');

  await stopModule.runStop();
  const updateIncrementally = incremental.updatePartitionedChartIncrementally as jest.MockedFunction<
    typeof incremental.updatePartitionedChartIncrementally
  >;
  updateIncrementally.mockClear();
  await rm(watchedPath);

  await stopModule.runStop();

  expect(updateIncrementally).toHaveBeenCalledWith([
    'watched.ts'
  ]);
  exitSpy.mockRestore();
});

test('runStop do nothing when no git repo exists (captureGitChanges returns null)', async () => {
  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: jest.fn(async () => {}),
  }));

  const exitSpy = mockProcessExit();

  const stopModule = await import('../../dist/hooks/public/stopPublic.js');
  const incremental = await import('../../dist/chartBuild/incremental.js');

  await stopModule.runStop();

  expect(incremental.updatePartitionedChartIncrementally).not.toHaveBeenCalled();
  expect(exitSpy).toHaveBeenCalledWith(0);

  exitSpy.mockRestore();
});


test('runStop retries an untracked deletion after refresh failure and acknowledges success', async () => {
  initGitRepo();
  const update = jest.fn<() => Promise<void>>();
  update.mockResolvedValue(undefined);
  jest.resetModules();
  jest.unstable_mockModule('../../dist/chartBuild/incremental.js', () => ({
    updatePartitionedChartIncrementally: update,
  }));
  const exitSpy = mockProcessExit();
  try {
    const hook = await import('../../dist/hooks/public/stopPublic.js');
    await writeFile('retry.ts', 'export const value = 1;');
    await hook.runStop();
    await rm('retry.ts');
    update.mockClear();
    update.mockRejectedValueOnce(new Error('refresh failed'));
    await expect(hook.runStop()).rejects.toThrow('refresh failed');
    expect(update).toHaveBeenLastCalledWith(['retry.ts']);
    await hook.runStop();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(['retry.ts']);
    await hook.runStop();
    expect(update).toHaveBeenCalledTimes(2);
  } finally {
    exitSpy.mockRestore();
  }
});
