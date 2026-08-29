import { afterAll, expect, test } from '@jest/globals';

import {
  createDirectoryTree,
  fromDirectoryTreeRegistry,
  getDeepestFirstNodes,
  rebuildChartTree,
  toDirectoryTreeRegistry
} from '../../dist/chartBuild/partition/directoryTree.js';
import {
  getDirectoriesToScan,
  getRootChartDirectories,
  getShallowPartitionDirectories,
  scanDirectoryTree
} from '../../dist/chartBuild/partition/partitioner.js';
import { destroyPool } from '../../dist/chartBuild/buildChart.js';
import {
  applyDirectoryCharsDelta,
  findPartitionForFile,
  getUniqueChangedDirectories
} from '../../dist/chartBuild/partition/incrementalPartitioner.js';
import type { DirectoryTreeRegistryNode } from '../../dist/chartBuild/partition/directoryTree.js';
import { assertDefined } from './testHelpers.ts';

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
  const scanOrder: string[] = [];
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

  const src = assertDefined(
    root.children.find(node => node.directory === 'src'),
    'Expected src directory'
  );
  const assets = assertDefined(
    root.children.find(node => node.directory === 'assets'),
    'Expected assets directory'
  );
  expect(src.thisDirectoryChars).toBe(18);
  expect(src.isSplit).toBe(false);
  expect(assets.thisDirectoryChars).toBe(13);
  expect(root.thisDirectoryChars).toBe(36);
  expect(root.isSplit).toBe(true);
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
  const frontend = assertDefined(
    root.children.find(node => node.directory === 'Frontend'),
    'Expected Frontend directory'
  );
  const backend = assertDefined(
    root.children.find(node => node.directory === 'Backend'),
    'Expected Backend directory'
  );
  const api = assertDefined(
    backend.children.find(node => node.directory === 'Backend/api'),
    'Expected Backend/api directory'
  );
  const database = assertDefined(
    backend.children.find(node => node.directory === 'Backend/database'),
    'Expected Backend/database directory'
  );

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
  const frontend = assertDefined(
    root.children.find(node => node.directory === 'Frontend'),
    'Expected Frontend directory'
  );
  const backend = assertDefined(
    root.children.find(node => node.directory === 'Backend'),
    'Expected Backend directory'
  );

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
  const packages = assertDefined(
    root.children.find(node => node.directory === 'packages'),
    'Expected packages directory'
  );
  const app = assertDefined(
    packages.children.find(node => node.directory === 'packages/app'),
    'Expected packages/app directory'
  );
  const src = assertDefined(
    root.children.find(node => node.directory === 'src'),
    'Expected src directory'
  );

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
  const aSource = assertDefined(
    root.children.find(node => node.directory === 'a'),
    'Expected a directory'
  );
  aSource.isSplit = true;
  let wrapper = aSource.children[0];
  while (wrapper.directory !== 'a/b/c/d/e/f') {
    wrapper.isSplit = true;
    wrapper = wrapper.children[0];
  }
  const other = assertDefined(
    root.children.find(node => node.directory === 'other'),
    'Expected other directory'
  );
  other.isSplit = true;
  rebuildChartTree(root);
  const registry = toDirectoryTreeRegistry(root);
  const registryA = assertDefined(
    registry.children.find(node => node.directory === 'a'),
    'Expected a registry node'
  );
  expect(registryA.chartParent).toBeNull();
  expect(registryA.chartChildren).toEqual(['a/b/c/d/e/f']);

  const restored = fromDirectoryTreeRegistry(registry);
  const a = assertDefined(
    restored.children.find(node => node.directory === 'a'),
    'Expected restored a directory'
  );
  const f = a.children[0].children[0].children[0].children[0].children[0];
  const restoredOther = assertDefined(
    restored.children.find(node => node.directory === 'other'),
    'Expected restored other directory'
  );
  const otherDeep = assertDefined(restoredOther.children[0], 'Expected restored other/deep directory');

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
  const stripEdges = (node: DirectoryTreeRegistryNode): void => {
    delete (node as Partial<DirectoryTreeRegistryNode>).chartParent;
    delete (node as Partial<DirectoryTreeRegistryNode>).chartChildren;
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

test('directory-scoped incremental preflight deduplicates changed files', () => {
  expect(getUniqueChangedDirectories([
    'src/a.ts',
    'src/b.ts',
    './src/c.ts',
    'tests/a.test.ts',
    'tests/deep/b.test.ts'
  ])).toEqual(['src', 'tests', 'tests/deep']);
});
