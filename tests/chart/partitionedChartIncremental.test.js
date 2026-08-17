import { afterAll, afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { destroyPool } from '../../dist/chartBuild/buildChart.js';
import {
  captureChartTopology,
  createPartitionedCharts,
  buildPartitionedChartsForDebug,
  rebuildPartitionBoundary
} from '../../dist/chartBuild/partition/partitionedChartBuilder.js';
import {
  createDirectoryTree,
  rebuildChartTree
} from '../../dist/chartBuild/partition/directoryTree.js';
import { updatePartitionedChartsIncrementally } from
  '../../dist/chartBuild/partition/incrementalPartitioner.js';

let tempDir = '';

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

afterAll(async () => {
  await destroyPool();
});

test('deleting a final direct file removes only its obsolete chart branch', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-prune-branch-'));
  await mkdir(path.join(tempDir, 'alpha'));
  await mkdir(path.join(tempDir, 'beta'));
  const alphaFile = path.join(tempDir, 'alpha', 'entry.ts');
  await writeFile(alphaFile, 'export function alpha() { return 1; }\n', 'utf8');
  await writeFile(
    path.join(tempDir, 'beta', 'entry.ts'),
    'export function beta() { return 2; }\n',
    'utf8'
  );
  const options = {
    projectRoot: tempDir,
    thresholds: { splitAt: 1, mergeAt: 0 }
  };
  await buildPartitionedChartsForDebug(options);

  const outputRoot = path.join(tempDir, '.memoryanchor', 'chart');
  const betaChartPath = path.join(outputRoot, 'beta', 'chart.md');
  const betaBefore = await readFile(betaChartPath, 'utf8');
  await rm(alphaFile);

  await expect(updatePartitionedChartsIncrementally(['alpha/entry.ts'], options))
    .resolves.toBe(true);

  await expect(readFile(path.join(outputRoot, 'alpha', 'chart.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(betaChartPath, 'utf8')).resolves.toBe(betaBefore);
  await expect(readFile(path.join(tempDir, '.memoryanchor', 'index.md'), 'utf8'))
    .resolves.not.toContain('.memoryanchor/chart/alpha/chart.md');
});

test('root direct files use the uniform shallow chart and update incrementally', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-root-owner-'));
  const rootFile = path.join(tempDir, 'index.ts');
  await writeFile(rootFile, 'export function rootFunction() {}\n', 'utf8');
  const srcDir = path.join(tempDir, 'src');
  await mkdir(srcDir);
  await writeFile(
    path.join(srcDir, 'worker.ts'),
    'export function workerFunction() {}\n',
    'utf8'
  );

  const thresholds = { splitAt: 1, mergeAt: 0 };
  const result = await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds
  });
  const outputRoot = path.join(tempDir, '.memoryanchor', 'chart');
  const rootChartPath = path.join(outputRoot, 'chart.md');
  const srcChartPath = path.join(outputRoot, 'src', 'chart.md');
  const indexPath = path.join(tempDir, '.memoryanchor', 'index.md');

  expect(result.directories).toEqual(['.', 'src']);
  await expect(readFile(rootChartPath, 'utf8')).resolves.toContain('rootFunction');
  await expect(readFile(rootChartPath, 'utf8')).resolves.toContain(
    '# CHART AT .memoryanchor/chart/chart.md'
  );
  await expect(readFile(rootChartPath, 'utf8')).resolves.not.toContain('workerFunction');
  await expect(readFile(rootChartPath, 'utf8')).resolves.toContain(
    '.memoryanchor/chart/src/chart.md'
  );
  await expect(readFile(srcChartPath, 'utf8')).resolves.toContain('workerFunction');
  await expect(readFile(srcChartPath, 'utf8')).resolves.not.toContain('rootFunction');
  const index = await readFile(indexPath, 'utf8');
  expect(index).toContain('.memoryanchor/chart/chart.md');
  expect(index).not.toContain('.memoryanchor/chart/src/chart.md');

  await writeFile(
    rootFile,
    'export function updatedRootFunction() {}\n',
    'utf8'
  );
  await expect(updatePartitionedChartsIncrementally(['index.ts'], {
    projectRoot: tempDir,
    thresholds
  })).resolves.toBe(true);
  await expect(readFile(rootChartPath, 'utf8')).resolves.toContain('updatedRootFunction');
  await expect(readFile(rootChartPath, 'utf8')).resolves.toContain(
    '.memoryanchor/chart/src/chart.md'
  );
  await expect(readFile(srcChartPath, 'utf8')).resolves.toContain('workerFunction');
});

test('adding the first root file creates a root chart and reparents child charts', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-new-root-owner-'));
  const srcDir = path.join(tempDir, 'src');
  await mkdir(srcDir);
  await writeFile(
    path.join(srcDir, 'worker.ts'),
    'export function workerFunction() {}\n',
    'utf8'
  );

  await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const baseChars = JSON.parse(await readFile(registryPath, 'utf8')).thisDirectoryChars;
  const thresholds = { splitAt: baseChars + 50, mergeAt: 0 };
  await buildPartitionedChartsForDebug({ projectRoot: tempDir, thresholds });

  const rootFunctions = Array.from(
    { length: 12 },
    (_, index) => `export function newRootFunction${index}() { return ${index}; }`
  ).join('\n');
  await writeFile(path.join(tempDir, 'index.ts'), `${rootFunctions}\n`, 'utf8');
  await expect(updatePartitionedChartsIncrementally(['index.ts'], {
    projectRoot: tempDir,
    thresholds
  })).resolves.toBe(true);

  const outputRoot = path.join(tempDir, '.memoryanchor', 'chart');
  await expect(readFile(path.join(outputRoot, 'chart.md'), 'utf8'))
    .resolves.toContain('newRootFunction11');
  await expect(readFile(path.join(outputRoot, 'chart.md'), 'utf8'))
    .resolves.not.toContain('workerFunction');
  await expect(readFile(path.join(outputRoot, 'chart.md'), 'utf8'))
    .resolves.toContain('.memoryanchor/chart/src/chart.md');
  await expect(readFile(path.join(outputRoot, 'src', 'chart.md'), 'utf8'))
    .resolves.toContain('workerFunction');
  const index = await readFile(path.join(tempDir, '.memoryanchor', 'index.md'), 'utf8');
  expect(index).toContain('.memoryanchor/chart/chart.md');
  expect(index).not.toContain('.memoryanchor/chart/src/chart.md');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  expect(registry.isSplit).toBe(true);
  expect(registry.hasDirectFiles).toBe(true);
});

test('crossing thresholds splits to frontier charts and merges back to root', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-boundary-update-'));
  const frontendDir = path.join(tempDir, 'Frontend');
  const backendDir = path.join(tempDir, 'Backend');
  await mkdir(frontendDir);
  await mkdir(backendDir);
  const frontendFile = path.join(frontendDir, 'index.ts');
  const originalFrontend = 'export function frontendBase() {}\n';
  await writeFile(frontendFile, originalFrontend, 'utf8');
  await writeFile(
    path.join(backendDir, 'server.ts'),
    'export function backendBase() {}\n',
    'utf8'
  );

  await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const baseChars = JSON.parse(await readFile(registryPath, 'utf8')).thisDirectoryChars;
  const thresholds = { splitAt: baseChars + 100, mergeAt: baseChars + 50 };
  await buildPartitionedChartsForDebug({ projectRoot: tempDir, thresholds });

  const addedFunctions = Array.from(
    { length: 12 },
    (_, index) => `export function addedFunctionNumber${index}() { return ${index}; }`
  ).join('\n');
  await writeFile(frontendFile, `${originalFrontend}${addedFunctions}\n`, 'utf8');
  await updatePartitionedChartsIncrementally(['Frontend/index.ts'], {
    projectRoot: tempDir,
    thresholds
  });

  const outputRoot = path.join(tempDir, '.memoryanchor', 'chart');
  await expect(readFile(path.join(outputRoot, 'chart.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(outputRoot, 'Frontend', 'chart.md'), 'utf8'))
    .resolves.toContain('addedFunctionNumber11');
  await expect(readFile(path.join(outputRoot, 'Backend', 'chart.md'), 'utf8'))
    .resolves.toContain('backendBase');

  await writeFile(frontendFile, originalFrontend, 'utf8');
  await updatePartitionedChartsIncrementally(['Frontend/index.ts'], {
    projectRoot: tempDir,
    thresholds
  });

  await expect(readFile(path.join(outputRoot, 'chart.md'), 'utf8'))
    .resolves.toContain('frontendBase');
  await expect(readFile(path.join(outputRoot, 'Frontend', 'chart.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  const mergedRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
  expect(mergedRegistry.isSplit).toBe(false);
});

test('a nested boundary rebuild leaves unrelated sibling charts untouched', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-local-boundary-'));
  const frontendDir = path.join(tempDir, 'Frontend');
  const deepDir = path.join(frontendDir, 'deep');
  const backendDir = path.join(tempDir, 'Backend');
  await mkdir(deepDir, { recursive: true });
  await mkdir(backendDir, { recursive: true });
  await writeFile(path.join(frontendDir, 'readme.md'), '# frontend\n', 'utf8');
  await writeFile(path.join(deepDir, 'detail.md'), '# detail\n', 'utf8');
  await writeFile(path.join(backendDir, 'server.md'), '# backend\n', 'utf8');

  const root = createDirectoryTree(['Frontend', 'Frontend/deep', 'Backend']);
  const frontend = root.children.find(node => node.directory === 'Frontend');
  const backend = root.children.find(node => node.directory === 'Backend');
  root.isSplit = true;
  frontend.isSplit = false;
  frontend.children[0].isSplit = false;
  backend.isSplit = false;
  rebuildChartTree(root);

  const previousTopology = captureChartTopology(root);
  await createPartitionedCharts(previousTopology.directories, {
    projectRoot: tempDir,
    shallowDirectories: previousTopology.shallowDirectories,
    chartChildren: previousTopology.chartChildren,
    rootDirectories: previousTopology.rootDirectories
  });
  const outputRoot = path.join(tempDir, '.memoryanchor', 'chart');
  const backendChartPath = path.join(outputRoot, 'Backend', 'chart.md');
  const backendBefore = await readFile(backendChartPath, 'utf8');

  frontend.isSplit = true;
  const rebuilt = await rebuildPartitionBoundary(root, frontend, {
    projectRoot: tempDir,
    previousTopology
  });

  expect(rebuilt).not.toContain(backendChartPath);
  await expect(readFile(backendChartPath, 'utf8')).resolves.toBe(backendBefore);
  const frontendChart = await readFile(
    path.join(outputRoot, 'Frontend', 'chart.md'),
    'utf8'
  );
  const deepChart = await readFile(
    path.join(outputRoot, 'Frontend', 'deep', 'chart.md'),
    'utf8'
  );
  expect(frontendChart).toContain('- /readme.md\n');
  expect(frontendChart).not.toContain('- detail.md\n');
  expect(frontendChart).toContain('.memoryanchor/chart/Frontend/deep/chart.md');
  expect(deepChart).toContain('- /detail.md\n');
});
