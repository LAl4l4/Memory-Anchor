import { afterAll, afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildDirectoryTreeRegistry,
  buildDirectoryTreeRegistryForDebug,
  destroyPool
} from '../../dist/chartBuild/buildChart.js';
import {
  buildPartitionedChartIndex,
  buildPartitionedChartsForDebug,
  createPartitionedCharts
} from '../../dist/chartBuild/partition/partitionedChartBuilder.js';

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

test('partition index uses a compact entry-chart list', () => {
  const index = buildPartitionedChartIndex(['Frontend', 'Backend']);

  expect(index).toContain('- `.memoryanchor/chart/Frontend/chart.md`');
  expect(index).toContain('- `.memoryanchor/chart/Backend/chart.md`');
  expect(index).not.toContain('- path:');
  expect(index).not.toContain('- scope:');
  expect(index).not.toContain('- [Frontend]');
  expect(index).not.toContain('### .memoryanchor/chart/Frontend/chart.md');
  expect(index).toContain('## Entry Charts');
  expect(index).toContain('Start with the entry chart closest to the task');
  expect(index).toContain('Listed chart paths are authoritative');
  expect(index).toContain('Legend: `+` exported');
});

test('automatic and debug entries write registries without changing chart.md', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-dir-tree-'));
  await writeFile(
    path.join(tempDir, 'index.ts'),
    'export function rootFunction() {}\n',
    'utf8'
  );
  const srcDir = path.join(tempDir, 'src');
  await mkdir(srcDir);
  await writeFile(
    path.join(srcDir, 'worker.ts'),
    'export function workerFunction() {}\n',
    'utf8'
  );

  const automaticRegistryPath = path.join(tempDir, '.memoryanchor', 'automatic-dirTree.json');
  const automaticRoot = await buildDirectoryTreeRegistry({
    projectRoot: tempDir,
    registryPath: automaticRegistryPath,
    thresholds: { splitAt: 1, mergeAt: 0 }
  });
  const root = await buildDirectoryTreeRegistryForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: 1, mergeAt: 0 }
  });
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const automaticRegistry = JSON.parse(await readFile(automaticRegistryPath, 'utf8'));

  expect(registry.thisDirectoryChars).toBe(root.thisDirectoryChars);
  expect(automaticRegistry.thisDirectoryChars).toBe(automaticRoot.thisDirectoryChars);
  expect(automaticRegistry.thisDirectoryChars).toBe(registry.thisDirectoryChars);
  expect(registry.thisDirectoryChars).toBeGreaterThan(0);
  expect(registry.isSplit).toBe(true);
  expect(registry.children[0].directory).toBe('src');
  expect(registry.children[0]).not.toHaveProperty('files');
  await expect(readFile(path.join(tempDir, '.memoryanchor', 'chart.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

test('a non-shallow frontier chart recursively scans its selected subtree', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-partitioned-chart-'));
  const frontendDir = path.join(tempDir, 'Frontend');
  const componentsDir = path.join(frontendDir, 'components');
  const backendDir = path.join(tempDir, 'Backend');
  await mkdir(componentsDir, { recursive: true });
  await mkdir(backendDir, { recursive: true });
  await writeFile(
    path.join(frontendDir, 'index.ts'),
    'export function frontendFunction() {}\n',
    'utf8'
  );
  await writeFile(
    path.join(componentsDir, 'button.ts'),
    'export function buttonFunction() {}\n',
    'utf8'
  );
  await writeFile(
    path.join(backendDir, 'server.ts'),
    'export function backendFunction() {}\n',
    'utf8'
  );
  const anchorDir = path.join(tempDir, '.memoryanchor');
  await mkdir(anchorDir);
  await writeFile(path.join(anchorDir, 'chart.md'), 'legacy chart\n', 'utf8');

  const chartPaths = await createPartitionedCharts(['Frontend'], {
    projectRoot: tempDir
  });
  const expectedChartPath = path.join(
    tempDir,
    '.memoryanchor',
    'chart',
    'Frontend',
    'chart.md'
  );
  const chart = await readFile(expectedChartPath, 'utf8');
  const index = await readFile(path.join(anchorDir, 'index.md'), 'utf8');

  expect(chartPaths).toEqual([expectedChartPath]);
  expect(chart).toContain('frontendFunction');
  expect(chart).toContain('buttonFunction');
  expect(chart).not.toContain('backendFunction');
  expect(chart).toContain('# Architecture: Frontend');
  expect(chart).toContain('> Chart: `.memoryanchor/chart/Frontend/chart.md`');
  expect(chart).toContain('> Scope: `Frontend/**` · Mode: recursive frontier · Files: 2');
  expect(chart).toContain('> Parent: none (entry chart)');
  expect(index).toContain('# Project Chart Index');
  expect(index).toContain('- `.memoryanchor/chart/Frontend/chart.md`');
  await expect(readFile(path.join(anchorDir, 'chart.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

test('debug partition entry builds registry and charts then returns its scan plan', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-partition-debug-'));
  await writeFile(
    path.join(tempDir, 'index.ts'),
    'export function rootFunction() {}\n',
    'utf8'
  );

  const result = await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 9000 }
  });
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const chartPath = path.join(tempDir, '.memoryanchor', 'chart', 'chart.md');
  const indexPath = path.join(tempDir, '.memoryanchor', 'index.md');

  expect(result.directories).toEqual(['.']);
  expect(result.chartPaths).toEqual([chartPath]);
  expect(result.indexPath).toBe(indexPath);
  await expect(readFile(registryPath, 'utf8')).resolves.toContain('thisDirectoryChars');
  await expect(readFile(chartPath, 'utf8')).resolves.toContain('rootFunction');
  await expect(readFile(indexPath, 'utf8')).resolves.toContain(
    '.memoryanchor/chart/chart.md'
  );
});

test('a small project with many directories is flattened into one root chart', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-small-flat-root-'));
  const aDir = path.join(tempDir, 'a');
  const fDir = path.join(aDir, 'b', 'c', 'd', 'e', 'f');
  await mkdir(fDir, { recursive: true });
  await writeFile(
    path.join(aDir, 'a.ts'),
    'export function aFunction() {}\n',
    'utf8'
  );
  await writeFile(
    path.join(fDir, 'f.ts'),
    'export function fFunction() {}\n',
    'utf8'
  );

  const result = await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const outputRoot = path.join(tempDir, '.memoryanchor', 'chart');
  const rootChart = await readFile(path.join(outputRoot, 'chart.md'), 'utf8');
  const index = await readFile(path.join(tempDir, '.memoryanchor', 'index.md'), 'utf8');

  expect(result.directories).toEqual(['.']);
  expect(rootChart).toContain('aFunction');
  expect(rootChart).toContain('fFunction');
  expect(rootChart).not.toContain('## Child Charts');
  expect(index).toContain('.memoryanchor/chart/chart.md');

  for (const nested of ['a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/f']) {
    await expect(readFile(path.join(outputRoot, nested, 'chart.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }
});

test('a split ancestor with direct files links to the first non-split frontier chart', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-threshold-frontier-'));
  const aDir = path.join(tempDir, 'a');
  const fDir = path.join(aDir, 'b', 'c', 'd', 'e', 'f');
  await mkdir(fDir, { recursive: true });
  const largeOwner = Array.from(
    { length: 40 },
    (_, index) => `export function aFunction${index}() { return ${index}; }`
  ).join('\n');
  await writeFile(path.join(aDir, 'a.ts'), `${largeOwner}\n`, 'utf8');
  await writeFile(path.join(fDir, 'f.ts'), 'export function fFunction() {}\n', 'utf8');

  await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const initialRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
  const aRegistry = initialRegistry.children[0];
  const bRegistry = aRegistry.children[0];
  const thresholds = { splitAt: bRegistry.thisDirectoryChars + 1, mergeAt: 0 };
  const result = await buildPartitionedChartsForDebug({ projectRoot: tempDir, thresholds });

  const outputRoot = path.join(tempDir, '.memoryanchor', 'chart');
  const aChart = await readFile(path.join(outputRoot, 'a', 'chart.md'), 'utf8');
  const frontierChart = await readFile(path.join(outputRoot, 'a', 'b', 'chart.md'), 'utf8');
  const index = await readFile(path.join(tempDir, '.memoryanchor', 'index.md'), 'utf8');

  expect(result.directories).toEqual(['a', 'a/b']);
  expect(aChart).toContain('aFunction39');
  expect(aChart).not.toContain('fFunction');
  expect(aChart).toContain('> Scope: `a/` · Mode: shallow (direct files only) · Files: 1');
  expect(aChart).toContain('- `b/` → `.memoryanchor/chart/a/b/chart.md`');
  expect(frontierChart).toContain('fFunction');
  expect(frontierChart).not.toContain('aFunction39');
  expect(frontierChart).toContain('> Scope: `a/b/**` · Mode: recursive frontier · Files: 1');
  expect(frontierChart).toContain('> Parent: `.memoryanchor/chart/a/chart.md`');
  expect(frontierChart).not.toContain('## Child Charts');
  expect(index).toContain('.memoryanchor/chart/a/chart.md');
  expect(index).not.toContain('.memoryanchor/chart/a/b/chart.md');

  for (const nested of ['a/b/c', 'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/f']) {
    await expect(readFile(path.join(outputRoot, nested, 'chart.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }
});
