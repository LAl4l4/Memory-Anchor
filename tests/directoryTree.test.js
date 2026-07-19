import { afterAll, afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDirectoryTree,
  getDeepestFirstNodes,
  toDirectoryTreeRegistry
} from '../dist/chartBuild/chartPartitioner/directoryTree.js';
import {
  buildDirectoryTreeRegistry,
  buildDirectoryTreeRegistryForDebug,
  getDirectoriesToScan,
  scanDirectoryTree
} from '../dist/chartBuild/chartPartitioner/partitioner.js';
import {
  buildPartitionedChartsForDebug,
  buildPartitionedChartIndex,
  createPartitionedCharts
} from '../dist/chartBuild/chartPartitioner/partitionedChartBuilder.js';
import { destroyPool } from '../dist/chartBuild/build-chart.js';
import {
  applyDirectoryCharsDelta,
  isFileCoveredByRebuiltDirectory,
  updatePartitionedChartsIncrementally
} from '../dist/chartBuild/chartPartitioner/incrementalPartitioner.js';

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

test('directory tree scans deepest directories first and rolls chars up', async () => {
  const groups = new Map([
    ['.', ['package.json']],
    ['src', ['src/index.ts']],
    ['src/deep', ['src/deep/worker.ts']],
    ['assets/icons', ['assets/icons/logo.svg']]
  ]);
  const root = createDirectoryTree(groups.keys());
  const scanOrder = [];
  const directoryChars = new Map([
    ['.', 5],
    ['src', 7],
    ['src/deep', 11],
    ['assets/icons', 13]
  ]);

  await scanDirectoryTree(root, async (directory) => {
    scanOrder.push(directory);
    return directoryChars.get(directory) ?? 0;
  }, { splitAt: 20, mergeAt: 15 });

  expect(scanOrder).toEqual(['assets/icons', 'assets', 'src/deep', 'src', '.']);
  expect(getDeepestFirstNodes(root).map(node => node.directory)).toEqual([
    'assets/icons',
    'assets',
    'src/deep',
    'src',
    '.'
  ]);

  const src = root.children.find(node => node.directory === 'src');
  const assets = root.children.find(node => node.directory === 'assets');
  expect(src.thisDirectoryChars).toBe(18);
  expect(src.isSplit).toBe(false);
  expect(assets.thisDirectoryChars).toBe(13);
  expect(root.thisDirectoryChars).toBe(36);
  expect(root.isSplit).toBe(true);
});

test('registry serialization replaces circular parent references with paths', () => {
  const root = createDirectoryTree(['src/deep']);
  const registry = toDirectoryTreeRegistry(root);

  expect(registry.parent).toBeNull();
  expect(registry.children[0].parent).toBe('.');
  expect(registry.children[0].children[0].parent).toBe('src');
  expect(() => JSON.stringify(registry)).not.toThrow();
});

test('directory selection returns the first non-split node on every branch', () => {
  const root = createDirectoryTree([
    'Frontend/components',
    'Backend/api',
    'Backend/database'
  ]);
  const frontend = root.children.find(node => node.directory === 'Frontend');
  const backend = root.children.find(node => node.directory === 'Backend');
  const api = backend.children.find(node => node.directory === 'Backend/api');
  const database = backend.children.find(node => node.directory === 'Backend/database');

  root.isSplit = true;
  frontend.isSplit = false;
  frontend.children[0].isSplit = false;
  backend.isSplit = true;
  api.isSplit = false;
  database.isSplit = false;

  expect(getDirectoriesToScan(root)).toEqual([
    'Backend/api',
    'Backend/database',
    'Frontend'
  ]);
});

test('directory char hysteresis splits above 12000 and merges below 9000', () => {
  const splitRoot = createDirectoryTree(['Frontend']);
  const frontend = splitRoot.children[0];
  splitRoot.isSplit = true;
  splitRoot.thisDirectoryChars = 15000;
  frontend.isSplit = false;
  frontend.thisDirectoryChars = 11900;

  const splitBoundary = applyDirectoryCharsDelta(frontend, 101);
  expect(splitBoundary).toBe(frontend);
  expect(frontend.isSplit).toBe(true);
  expect(frontend.thisDirectoryChars).toBe(12001);
  expect(splitRoot.thisDirectoryChars).toBe(15101);

  const mergeRoot = createDirectoryTree(['Frontend']);
  const mergeFrontend = mergeRoot.children[0];
  mergeRoot.isSplit = true;
  mergeRoot.thisDirectoryChars = 9100;
  mergeFrontend.isSplit = false;
  mergeFrontend.thisDirectoryChars = 2000;

  const mergeBoundary = applyDirectoryCharsDelta(mergeFrontend, -101);
  expect(mergeBoundary).toBe(mergeRoot);
  expect(mergeRoot.isSplit).toBe(false);
  expect(mergeRoot.thisDirectoryChars).toBe(8999);
});

test('a merge keeps propagating through every eligible ancestor to root', () => {
  const root = createDirectoryTree(['src/feature']);
  const src = root.children[0];
  const feature = src.children[0];
  root.isSplit = true;
  root.thisDirectoryChars = 9050;
  src.isSplit = true;
  src.thisDirectoryChars = 9025;
  feature.isSplit = false;
  feature.thisDirectoryChars = 1000;

  const mergeBoundary = applyDirectoryCharsDelta(feature, -100);

  expect(mergeBoundary).toBe(root);
  expect(feature.thisDirectoryChars).toBe(900);
  expect(src.thisDirectoryChars).toBe(8925);
  expect(src.isSplit).toBe(false);
  expect(root.thisDirectoryChars).toBe(8950);
  expect(root.isSplit).toBe(false);
});

test('rebuilt-directory records match only the directory and its descendants', () => {
  const rebuiltDirectories = new Set(['src/a']);

  expect(isFileCoveredByRebuiltDirectory('src/a/index.ts', rebuiltDirectories)).toBe(true);
  expect(isFileCoveredByRebuiltDirectory('src/a/deep/index.ts', rebuiltDirectories)).toBe(true);
  expect(isFileCoveredByRebuiltDirectory('src/abc/index.ts', rebuiltDirectories)).toBe(false);
  expect(isFileCoveredByRebuiltDirectory('src/index.ts', rebuiltDirectories)).toBe(false);
  expect(isFileCoveredByRebuiltDirectory('anything.ts', new Set(['.']))).toBe(true);
});

test('partition index uses heading blocks, workspace paths, and inferred scopes', () => {
  const index = buildPartitionedChartIndex(['Frontend', 'Backend']);

  expect(index).toContain(`### Frontend

path:
.memoryanchor/chart/Frontend/chart.md

scope:
UI, React components, client APIs, state management.`);
  expect(index).toContain(`### Backend

path:
.memoryanchor/chart/Backend/chart.md

scope:
Spring Boot controllers, services, entities, database.`);
  expect(index).not.toContain('- [Frontend]');
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

test('partitioned chart builder mirrors selected directories and scans their subtrees', async () => {
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
  expect(index).toContain('# Project Chart Index');
  expect(index).toContain('### Frontend');
  expect(index).toContain('.memoryanchor/chart/Frontend/chart.md');
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

test('incremental boundary changes rebuild only the affected partition topology', async () => {
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
