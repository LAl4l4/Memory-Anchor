import { afterAll, afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { destroyPool } from '../../dist/chartBuild/buildChart.js';
import {
  buildPartitionedChartsForDebug
} from '../../dist/chartBuild/partition/partitionedChartBuilder.js';
import { updatePartitionedChartsIncrementally } from
  '../../dist/chartBuild/partition/incrementalPartitioner.js';
import type { DirectoryTreeRegistryNode } from
  '../../dist/chartBuild/partition/directoryTree.js';
import type { PersistentDependencyGraph } from '../../dist/chartBuild/shared/CBHTypes.js';
import { assertDefined } from './testHelpers.ts';

let tempDir = '';

async function readRegistry(registryPath: string): Promise<DirectoryTreeRegistryNode> {
  return JSON.parse(await readFile(registryPath, 'utf8')) as DirectoryTreeRegistryNode;
}

function getDirectoryChars(registry: DirectoryTreeRegistryNode, directory: string): number {
  return assertDefined(
    registry.children.find(node => node.directory === directory),
    `Expected ${directory} directory in registry`
  ).thisDirectoryChars;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

afterAll(async () => {
  await destroyPool();
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

test('a topology rebuild retains cross-partition reverse callers', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-boundary-registry-'));
  await mkdir(path.join(tempDir, 'providers'));
  await mkdir(path.join(tempDir, 'consumers'));
  const providerPath = path.join(tempDir, 'providers', 'shared.ts');
  await writeFile(
    providerPath,
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
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const baseChars = (await readRegistry(registryPath)).thisDirectoryChars;
  const thresholds = { splitAt: baseChars + 100, mergeAt: baseChars + 50 };
  await buildPartitionedChartsForDebug({ projectRoot: tempDir, thresholds });

  const extraSymbols = Array.from(
    { length: 12 },
    (_, index) => `export function expanded${index}() { return ${index}; }`
  ).join('\n');
  await writeFile(providerPath, `${
    'export function shared() { return 1; }\n'
  }${extraSymbols}\n`, 'utf8');

  await expect(updatePartitionedChartsIncrementally(['providers/shared.ts'], {
    projectRoot: tempDir,
    thresholds
  })).resolves.toBe(true);

  const providerChart = await readFile(
    path.join(tempDir, '.memoryanchor', 'chart', 'providers', 'chart.md'),
    'utf8'
  );
  expect(providerChart).toContain(
      '+ shared() [L1-1] <- consumers/caller.ts:caller()'
  );
});

test('incremental refresh persists forward and reverse edges and rerenders dirty target charts', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-persistent-graph-'));
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
      'export function caller() { return 0; }\n',
    'utf8'
  );

  const options = {
    projectRoot: tempDir,
    thresholds: { splitAt: 1, mergeAt: 0 }
  };
  await buildPartitionedChartsForDebug(options);
  const graphPath = path.join(tempDir, '.memoryanchor', 'dependencyGraph.json');
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const initialProviderChars = getDirectoryChars(await readRegistry(registryPath), 'providers');
  const initialGraph = JSON.parse(await readFile(graphPath, 'utf8')) as PersistentDependencyGraph;
  expect(initialGraph).toMatchObject({
    version: 2,
    forwardDependencies: expect.any(Object),
    reverseDependencies: expect.any(Object),
    fileForwardDependencies: expect.any(Object),
    fileReverseDependencies: expect.any(Object)
  });

  await writeFile(
    path.join(tempDir, 'consumers', 'caller.ts'),
    'import { shared } from "../providers/shared.js";\n' +
      'export function caller() { return shared(); }\n',
    'utf8'
  );
  await expect(updatePartitionedChartsIncrementally(['consumers/caller.ts'], options))
    .resolves.toBe(true);

  const targetKey = 'providers/shared.ts\0shared';
  let graph = JSON.parse(await readFile(graphPath, 'utf8')) as PersistentDependencyGraph;
  expect(Object.values(graph.forwardDependencies).some(targets =>
    targets.includes(targetKey)
  )).toBe(true);
  expect(Object.values(graph.reverseDependencies).some(callers => callers.length > 0)).toBe(true);
  let providerChart = await readFile(
    path.join(tempDir, '.memoryanchor', 'chart', 'providers', 'chart.md'),
    'utf8'
  );
  expect(providerChart).toContain('<- consumers/caller.ts:caller()');
  const providerWithCallerChars = getDirectoryChars(await readRegistry(registryPath), 'providers');
  expect(providerWithCallerChars).toBeGreaterThan(initialProviderChars);

  await writeFile(
    path.join(tempDir, 'consumers', 'caller.ts'),
    'import { shared } from "../providers/shared.js";\n' +
      'export const unchanged = 0;\n',
    'utf8'
  );
  await expect(updatePartitionedChartsIncrementally(['consumers/caller.ts'], options))
    .resolves.toBe(true);

  graph = JSON.parse(await readFile(graphPath, 'utf8')) as PersistentDependencyGraph;
  expect(Object.values(graph.forwardDependencies).every(targets =>
    !targets.includes(targetKey)
  )).toBe(true);
  providerChart = await readFile(
    path.join(tempDir, '.memoryanchor', 'chart', 'providers', 'chart.md'),
    'utf8'
  );
  expect(providerChart).not.toContain('<- consumers/caller.ts:caller()');
  const providerWithoutCallerChars = getDirectoryChars(await readRegistry(registryPath), 'providers');
  expect(providerWithoutCallerChars).toBe(initialProviderChars);

  await writeFile(
    path.join(tempDir, 'consumers', 'caller.ts'),
    'import { shared } from "../providers/shared.js";\n' +
      'export function addedCaller() { return shared(); }\n',
    'utf8'
  );
  await expect(updatePartitionedChartsIncrementally(['consumers/caller.ts'], options))
    .resolves.toBe(true);

  providerChart = await readFile(
    path.join(tempDir, '.memoryanchor', 'chart', 'providers', 'chart.md'),
    'utf8'
  );
  expect(providerChart).toContain('<- consumers/caller.ts:addedCaller()');
});

test('creating a dependency target refreshes unchanged importer charts', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-file-edge-'));
  await mkdir(path.join(tempDir, 'providers'));
  await mkdir(path.join(tempDir, 'consumers'));
  await writeFile(
    path.join(tempDir, 'providers', 'existing.ts'),
    'export const existing = 1;\n',
    'utf8'
  );
  await writeFile(
    path.join(tempDir, 'consumers', 'caller.ts'),
    'import { target } from "../providers/target.js";\n' +
      'export function caller() { return target(); }\n',
    'utf8'
  );

  const options = {
    projectRoot: tempDir,
    thresholds: { splitAt: 1, mergeAt: 0 }
  };
  await buildPartitionedChartsForDebug(options);
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const initialConsumerChars = getDirectoryChars(await readRegistry(registryPath), 'consumers');
  const consumerChartPath = path.join(
    tempDir,
    '.memoryanchor',
    'chart',
    'consumers',
    'chart.md'
  );
  await expect(readFile(consumerChartPath, 'utf8'))
    .resolves.not.toContain('-> ../providers/target.ts');

  await writeFile(
    path.join(tempDir, 'providers', 'target.ts'),
    'export function target() { return 1; }\n',
    'utf8'
  );
  await expect(updatePartitionedChartsIncrementally(['providers/target.ts'], options))
    .resolves.toBe(true);

  await expect(readFile(consumerChartPath, 'utf8'))
    .resolves.toContain('-> ../providers/target.ts');
  const resolvedConsumerChars = getDirectoryChars(await readRegistry(registryPath), 'consumers');
  expect(resolvedConsumerChars).toBeGreaterThan(initialConsumerChars);

  await rm(path.join(tempDir, 'providers', 'target.ts'));
  await expect(updatePartitionedChartsIncrementally(['providers/target.ts'], options))
    .resolves.toBe(true);

  await expect(readFile(consumerChartPath, 'utf8'))
    .resolves.not.toContain('-> ../providers/target.ts');
  const unresolvedConsumerChars = getDirectoryChars(await readRegistry(registryPath), 'consumers');
  expect(unresolvedConsumerChars).toBe(initialConsumerChars);
});

test('graph-only importer size changes rebuild the affected topology boundary', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-graph-topology-'));
  await mkdir(path.join(tempDir, 'providers'));
  await mkdir(path.join(tempDir, 'consumers', 'nested'), { recursive: true });
  const targetStem = `target_${'x'.repeat(80)}`;
  await writeFile(
    path.join(tempDir, 'providers', 'existing.ts'),
    'export const existing = 1;\n',
    'utf8'
  );
  await writeFile(
    path.join(tempDir, 'consumers', 'caller.ts'),
    `import { target } from "../providers/${targetStem}.js";\n` +
      'export function caller() { return target(); }\n',
    'utf8'
  );
  await writeFile(
    path.join(tempDir, 'consumers', 'nested', 'keep.ts'),
    'export const keep = true;\n',
    'utf8'
  );

  await buildPartitionedChartsForDebug({
    projectRoot: tempDir,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const registryPath = path.join(tempDir, '.memoryanchor', 'dirTree.json');
  const consumerChars = getDirectoryChars(await readRegistry(registryPath), 'consumers');
  const options = {
    projectRoot: tempDir,
    thresholds: { splitAt: consumerChars + 10, mergeAt: consumerChars + 5 }
  };
  await buildPartitionedChartsForDebug(options);

  const nestedChartPath = path.join(
    tempDir,
    '.memoryanchor',
    'chart',
    'consumers',
    'nested',
    'chart.md'
  );
  await expect(readFile(nestedChartPath, 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });

  const targetPath = path.join(tempDir, 'providers', `${targetStem}.ts`);
  await writeFile(targetPath, 'export function target() { return 1; }\n', 'utf8');
  await expect(updatePartitionedChartsIncrementally([
    `providers/${targetStem}.ts`
  ], options)).resolves.toBe(true);

  await expect(readFile(nestedChartPath, 'utf8')).resolves.toContain('keep.ts');

  await rm(targetPath);
  await expect(updatePartitionedChartsIncrementally([
    `providers/${targetStem}.ts`
  ], options)).resolves.toBe(true);

  await expect(readFile(nestedChartPath, 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
});
