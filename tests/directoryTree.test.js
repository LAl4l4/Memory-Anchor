import { afterAll, afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDirectoryTree,
  fromDirectoryTreeRegistry,
  getDeepestFirstNodes,
  rebuildChartTree,
  toDirectoryTreeRegistry
} from '../dist/chartBuild/partition/directoryTree.js';
import {
  buildDirectoryTreeRegistry,
  buildDirectoryTreeRegistryForDebug
} from '../dist/chartBuild/buildChart.js';
import {
  getDirectoriesToScan,
  getRootChartDirectories,
  getShallowPartitionDirectories,
  scanDirectoryTree
} from '../dist/chartBuild/partition/partitioner.js';
import {
  buildPartitionedChartsForDebug,
  buildPartitionedChartIndex,
  captureChartTopology,
  createPartitionedCharts,
  rebuildPartitionBoundary
} from '../dist/chartBuild/partition/partitionedChartBuilder.js';
import { destroyPool } from '../dist/chartBuild/buildChart.js';
import {
  applyDirectoryCharsDelta,
  findPartitionForFile,
  getUniqueChangedDirectories,
  isFileCoveredByRebuiltDirectory,
  updatePartitionedChartsIncrementally
} from '../dist/chartBuild/partition/incrementalPartitioner.js';

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

test('partition charts render callers from the build-wide dependency registry', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-global-registry-'));
  await mkdir(path.join(tempDir, 'providers'));
  await mkdir(path.join(tempDir, 'consumers'));
  await writeFile(
    path.join(tempDir, 'providers', 'shared.ts'),
    'export function shared() { return 1; }\n',
    'utf8'
  );
  await writeFile(
    path.join(tempDir, 'consumers', 'caller.ts'),
    'import { shared } from "../providers/shared.js";\n' +
      'export function caller() { return shared(); }\n',
    'utf8'
  );

  await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: 1, mergeAt: 0 }
  });

  const providerChart = await readFile(
    path.join(tempDir, '.memoryanchor', 'chart', 'providers', 'chart.md'),
    'utf8'
  );
  expect(providerChart).toContain(
    '+ shared() [L1-1] <- consumers/caller.ts:caller()'
  );
});

test('registry serialization replaces circular parent references with paths', () => {
  const root = createDirectoryTree(['src', 'src/deep']);
  const src = root.children[0];
  root.isSplit = true;
  src.isSplit = true;
  rebuildChartTree(root);
  const registry = toDirectoryTreeRegistry(root);

  expect(registry.parent).toBeNull();
  expect(registry.children[0].parent).toBe('.');
  expect(registry.children[0].children[0].parent).toBe('src');
  expect(registry.children[0].chartParent).toBeNull();
  expect(registry.children[0].chartChildren).toEqual(['src/deep']);
  expect(registry.children[0].children[0].chartParent).toBe('src');
  expect(registry.children[0].children[0].chartChildren).toEqual([]);
  expect(() => JSON.stringify(registry)).not.toThrow();
});

test('directory selection stops at the first non-split node on every branch', () => {
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

test('split ancestors with direct files supplement the non-split frontier', () => {
  const root = createDirectoryTree([
    '.',
    'Frontend/components',
    'Backend',
    'Backend/api'
  ]);
  const frontend = root.children.find(node => node.directory === 'Frontend');
  const backend = root.children.find(node => node.directory === 'Backend');

  root.isSplit = true;
  frontend.isSplit = false;
  backend.isSplit = true;
  backend.children[0].isSplit = false;

  expect(getDirectoriesToScan(root)).toEqual([
    '.',
    'Backend',
    'Backend/api',
    'Frontend'
  ]);
  expect([...getShallowPartitionDirectories(root)]).toEqual([
    '.',
    'Backend'
  ]);
});

test('direct files resolve only to their exact virtual-chart owner', () => {
  const root = createDirectoryTree(['packages', 'packages/app', 'src']);
  const packages = root.children.find(node => node.directory === 'packages');
  const app = packages.children.find(node => node.directory === 'packages/app');
  const src = root.children.find(node => node.directory === 'src');

  root.isSplit = true;
  packages.isSplit = true;
  app.isSplit = false;
  src.isSplit = false;

  expect(findPartitionForFile(root, 'package.json')).toBeNull();
  expect(findPartitionForFile(root, 'packages/package.json')).toBe(packages);
  expect(findPartitionForFile(root, 'packages/app/page.ts')).toBe(app);
  expect(findPartitionForFile(root, 'src/index.ts')).toBe(src);
});

test('virtual chart edges skip file-less wrapper directories and survive registry reload', () => {
  const root = createDirectoryTree(['a', 'a/b/c/d/e/f', 'other/deep']);
  root.isSplit = true;
  const aSource = root.children.find(node => node.directory === 'a');
  aSource.isSplit = true;
  let wrapper = aSource.children[0];
  while (wrapper.directory !== 'a/b/c/d/e/f') {
    wrapper.isSplit = true;
    wrapper = wrapper.children[0];
  }
  const other = root.children.find(node => node.directory === 'other');
  other.isSplit = true;
  rebuildChartTree(root);
  const registry = toDirectoryTreeRegistry(root);
  const registryA = registry.children.find(node => node.directory === 'a');
  expect(registryA.chartParent).toBeNull();
  expect(registryA.chartChildren).toEqual(['a/b/c/d/e/f']);

  const restored = fromDirectoryTreeRegistry(registry);
  const a = restored.children.find(node => node.directory === 'a');
  const f = a.children[0].children[0].children[0].children[0].children[0];
  const otherDeep = restored.children
    .find(node => node.directory === 'other').children[0];

  expect(getRootChartDirectories(restored)).toEqual(['a', 'other/deep']);
  expect(a.chartParent).toBeNull();
  expect(Array.isArray(a.chartChildren)).toBe(true);
  expect(a.chartChildren).toEqual([f]);
  expect(f.chartParent).toBe(a);
  expect(otherDeep.chartParent).toBeNull();
});

test('legacy registries without persisted chart edges rebuild them once', () => {
  const source = createDirectoryTree(['a', 'a/b/c/d/e/f']);
  source.isSplit = true;
  const sourceA = source.children[0];
  sourceA.isSplit = true;
  let sourceWrapper = sourceA.children[0];
  while (sourceWrapper.directory !== 'a/b/c/d/e/f') {
    sourceWrapper.isSplit = true;
    sourceWrapper = sourceWrapper.children[0];
  }
  rebuildChartTree(source);
  const registry = toDirectoryTreeRegistry(source);
  const stripEdges = node => {
    delete node.chartParent;
    delete node.chartChildren;
    node.children.forEach(stripEdges);
  };
  stripEdges(registry);

  const restored = fromDirectoryTreeRegistry(registry);
  const a = restored.children[0];
  const f = a.children[0].children[0].children[0].children[0].children[0];
  expect(a.chartChildren).toEqual([f]);
  expect(f.chartParent).toBe(a);
});

test('persisted chart edges are restored without recomputing nearest owners', () => {
  const source = createDirectoryTree(['a', 'a/b']);
  source.isSplit = true;
  source.children[0].isSplit = true;
  rebuildChartTree(source);
  const registry = toDirectoryTreeRegistry(source);
  const registryA = registry.children[0];
  const registryB = registryA.children[0];
  registryA.chartChildren = [];
  registryB.chartParent = null;

  const restored = fromDirectoryTreeRegistry(registry);
  const a = restored.children[0];
  const b = a.children[0];
  expect(a.chartChildren).toEqual([]);
  expect(b.chartParent).toBeNull();
  expect(getRootChartDirectories(restored)).toEqual(['a', 'a/b']);
});

test('directory char hysteresis splits above 18000 and merges below 14000', () => {
  const splitRoot = createDirectoryTree(['Frontend']);
  const frontend = splitRoot.children[0];
  splitRoot.isSplit = true;
  splitRoot.thisDirectoryChars = 20000;
  frontend.isSplit = false;
  frontend.thisDirectoryChars = 17900;

  const splitBoundary = applyDirectoryCharsDelta(frontend, 101);
  expect(splitBoundary).toBe(frontend);
  expect(frontend.isSplit).toBe(true);
  expect(frontend.thisDirectoryChars).toBe(18001);
  expect(splitRoot.thisDirectoryChars).toBe(20101);

  const mergeRoot = createDirectoryTree(['Frontend']);
  const mergeFrontend = mergeRoot.children[0];
  mergeRoot.isSplit = true;
  mergeRoot.thisDirectoryChars = 14100;
  mergeFrontend.isSplit = false;
  mergeFrontend.thisDirectoryChars = 2000;

  const mergeBoundary = applyDirectoryCharsDelta(mergeFrontend, -101);
  expect(mergeBoundary).toBe(mergeRoot);
  expect(mergeRoot.isSplit).toBe(false);
  expect(mergeRoot.thisDirectoryChars).toBe(13999);
});

test('a merge keeps propagating through every eligible ancestor to root', () => {
  const root = createDirectoryTree(['src/feature']);
  const src = root.children[0];
  const feature = src.children[0];
  root.isSplit = true;
  root.thisDirectoryChars = 14050;
  src.isSplit = true;
  src.thisDirectoryChars = 14025;
  feature.isSplit = false;
  feature.thisDirectoryChars = 1000;

  const mergeBoundary = applyDirectoryCharsDelta(feature, -100);

  expect(mergeBoundary).toBe(root);
  expect(feature.thisDirectoryChars).toBe(900);
  expect(src.thisDirectoryChars).toBe(13925);
  expect(src.isSplit).toBe(false);
  expect(root.thisDirectoryChars).toBe(13950);
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

test('directory-scoped incremental preflight deduplicates changed files', () => {
  expect(getUniqueChangedDirectories([
    'src/a.ts',
    'src/b.ts',
    './src/c.ts',
    'tests/a.test.ts',
    'tests/deep/b.test.ts'
  ])).toEqual(['src', 'tests', 'tests/deep']);
});

test('partition index uses workspace paths as heading blocks', () => {
  const index = buildPartitionedChartIndex(['Frontend', 'Backend']);

  expect(index).toContain('### .memoryanchor/chart/Frontend/chart.md');
  expect(index).toContain('### .memoryanchor/chart/Backend/chart.md');
  expect(index).not.toContain('- path:');
  expect(index).not.toContain('- scope:');
  expect(index).not.toContain('- [Frontend]');
  expect(index).toContain('How to find the right chart:');
  expect(index).toContain('whose path is closest to the task');
  expect(index).toContain('follow only the listed paths');
  expect(index).toContain('A non-split frontier');
  expect(index).toContain('Follow only listed paths');
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
  expect(index).toContain('# Project Chart Index');
  expect(index).toContain('### .memoryanchor/chart/Frontend/chart.md');
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
  expect(rootChart).not.toContain('## 3. Child Charts');
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
  expect(aChart).toContain('.memoryanchor/chart/a/b/chart.md');
  expect(frontierChart).toContain('fFunction');
  expect(frontierChart).not.toContain('aFunction39');
  expect(frontierChart).not.toContain('## 3. Child Charts');
  expect(index).toContain('.memoryanchor/chart/a/chart.md');
  expect(index).not.toContain('.memoryanchor/chart/a/b/chart.md');

  for (const nested of ['a/b/c', 'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/f']) {
    await expect(readFile(path.join(outputRoot, nested, 'chart.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }
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
