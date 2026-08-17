import { afterAll, afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { destroyPool } from '../../dist/chartBuild/buildChart.js';
import {
  buildPartitionedChartsForDebug
} from '../../dist/chartBuild/partition/partitionedChartBuilder.js';
import { updatePartitionedChartsIncrementally } from
  '../../dist/chartBuild/partition/incrementalPartitioner.js';
import { snapshotDirectory } from '../chart/testHelpers.js';

const temporaryProjects = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

afterAll(async () => {
  await destroyPool();
});

test('full and incremental builds produce identical graphs and charts after a large cross-chart dependency switch', async () => {
  const fullProject = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-consistency-graph-full-'));
  const incrementalProject = await mkdtemp(
    path.join(os.tmpdir(), 'memory-anchor-consistency-graph-incremental-')
  );
  temporaryProjects.push(fullProject, incrementalProject);

  const makeLargeModule = (prefix, header) => `${header}\n${Array.from(
    { length: 220 },
    (_, index) => `function ${prefix}Padding${index}() { return ${index}; }`
  ).join('\n')}\n`;

  const makeConsumer = (name, target) => {
    const targetPath = target === 'shared' ? 'shared' : 'other';
    return makeLargeModule(
      name,
      `import { ${target} } from "../providers/${targetPath}.js";\n` +
        `export function ${name}() { return ${target}(); }`
    );
  };

  const writeWorkspace = async (projectRoot, updated) => {
    await mkdir(path.join(projectRoot, 'providers'), { recursive: true });
    await mkdir(path.join(projectRoot, 'consumers'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'providers', 'shared.ts'),
      makeLargeModule('shared', 'export function shared() { return 1; }'),
      'utf8'
    );
    await writeFile(
      path.join(projectRoot, 'providers', 'other.ts'),
      makeLargeModule('other', 'export function other() { return 2; }'),
      'utf8'
    );
    await writeFile(
      path.join(projectRoot, 'consumers', 'alpha.ts'),
      makeConsumer('alpha', updated ? 'other' : 'shared'),
      'utf8'
    );
    await writeFile(
      path.join(projectRoot, 'consumers', 'beta.ts'),
      makeConsumer('beta', updated ? 'other' : 'shared'),
      'utf8'
    );
    await writeFile(
      path.join(projectRoot, 'consumers', 'gamma.ts'),
      makeConsumer('gamma', 'other'),
      'utf8'
    );
  };

  await writeWorkspace(fullProject, false);
  await writeWorkspace(incrementalProject, false);

  const initialBuild = await buildPartitionedChartsForDebug({
    projectRoot: fullProject,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const provider = initialBuild.root.children.find(node => node.directory === 'providers');
  const consumers = initialBuild.root.children.find(node => node.directory === 'consumers');
  expect(provider).toBeDefined();
  expect(consumers).toBeDefined();
  const thresholds = {
    splitAt: Math.max(1, Math.min(provider.thisDirectoryChars, consumers.thisDirectoryChars) - 1000),
    mergeAt: 0,
  };

  await buildPartitionedChartsForDebug({ projectRoot: fullProject, thresholds });
  await buildPartitionedChartsForDebug({
    projectRoot: incrementalProject,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  await buildPartitionedChartsForDebug({ projectRoot: incrementalProject, thresholds });

  await writeWorkspace(fullProject, true);
  await writeWorkspace(incrementalProject, true);

  await buildPartitionedChartsForDebug({ projectRoot: fullProject, thresholds });
  await expect(updatePartitionedChartsIncrementally([
    'consumers/alpha.ts',
    'consumers/beta.ts',
  ], { projectRoot: incrementalProject, thresholds })).resolves.toBe(true);

  const fullArtifacts = await snapshotDirectory(path.join(fullProject, '.memoryanchor'));
  const incrementalArtifacts = await snapshotDirectory(
    path.join(incrementalProject, '.memoryanchor')
  );
  expect(incrementalArtifacts).toEqual(fullArtifacts);

  const graph = fullArtifacts['dependencyGraph.json'];
  const callerPaths = targetKey => (graph.reverseDependencies[targetKey] ?? [])
    .map(callerId => graph.callerSymbols[callerId].sourcePath)
    .sort();
  expect(callerPaths('providers/shared.ts\0shared')).toEqual([]);
  expect(callerPaths('providers/other.ts\0other')).toEqual([
    'consumers/alpha.ts',
    'consumers/beta.ts',
    'consumers/gamma.ts',
  ]);

  const providerSymbolLines = fullArtifacts['chart/providers/chart.md'].split('\n');
  const sharedSymbolLine = providerSymbolLines.find(line => line.startsWith('+ shared()'));
  const otherSymbolLine = providerSymbolLines.find(line => line.startsWith('+ other()'));
  expect(sharedSymbolLine).toBeDefined();
  expect(sharedSymbolLine).not.toContain('<-');
  expect(otherSymbolLine).toEqual(expect.stringContaining('consumers/alpha.ts:alpha()'));
  expect(otherSymbolLine).toEqual(expect.stringContaining('consumers/beta.ts:beta()'));
  expect(otherSymbolLine).toEqual(expect.stringContaining('consumers/gamma.ts:gamma()'));
});
