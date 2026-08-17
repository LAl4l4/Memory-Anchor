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

test('full and incremental builds produce identical artifacts after one batch adds virtual child directories', async () => {
  const fullProject = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-consistency-full-'));
  const incrementalProject = await mkdtemp(
    path.join(os.tmpdir(), 'memory-anchor-consistency-incremental-')
  );
  temporaryProjects.push(fullProject, incrementalProject);

  const seedWorkspace = async projectRoot => {
    const benchDir = path.join(projectRoot, 'bench');
    await mkdir(benchDir, { recursive: true });
    const source = Array.from(
      { length: 36 },
      (_, index) => `export function benchFunction${index}() { return ${index}; }`
    ).join('\n');
    await writeFile(path.join(benchDir, 'entry.ts'), `${source}\n`, 'utf8');
    await writeFile(
      path.join(projectRoot, 'root.ts'),
      'export function rootFunction() { return 1; }\n',
      'utf8'
    );
  };

  const addedFiles = [
    ['bench/demo-crosschart/alpha/entry.ts', 'export function alpha() { return 1; }\n'],
    ['bench/demo-crosschart/beta/entry.ts', 'export function beta() { return 2; }\n'],
    ['bench/another-crosschart/entry.ts', 'export function another() { return 3; }\n'],
  ];

  const addFiles = async projectRoot => {
    for (const [relativeFile, content] of addedFiles) {
      const absoluteFile = path.join(projectRoot, relativeFile);
      await mkdir(path.dirname(absoluteFile), { recursive: true });
      await writeFile(absoluteFile, content, 'utf8');
    }
  };

  await seedWorkspace(fullProject);
  await seedWorkspace(incrementalProject);

  const initialBuild = await buildPartitionedChartsForDebug({
    projectRoot: fullProject,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  const bench = initialBuild.root.children.find(node => node.directory === 'bench');
  expect(bench).toBeDefined();
  const thresholds = { splitAt: bench.thisDirectoryChars - 1, mergeAt: 0 };

  await buildPartitionedChartsForDebug({ projectRoot: fullProject, thresholds });
  await buildPartitionedChartsForDebug({
    projectRoot: incrementalProject,
    thresholds: { splitAt: Number.MAX_SAFE_INTEGER, mergeAt: 0 }
  });
  await buildPartitionedChartsForDebug({ projectRoot: incrementalProject, thresholds });

  await addFiles(fullProject);
  await addFiles(incrementalProject);

  await buildPartitionedChartsForDebug({ projectRoot: fullProject, thresholds });
  await expect(updatePartitionedChartsIncrementally(
    addedFiles.map(([relativeFile]) => relativeFile),
    { projectRoot: incrementalProject, thresholds }
  )).resolves.toBe(true);

  const fullArtifacts = await snapshotDirectory(path.join(fullProject, '.memoryanchor'));
  const incrementalArtifacts = await snapshotDirectory(
    path.join(incrementalProject, '.memoryanchor')
  );

  expect(Object.keys(fullArtifacts)).toEqual(expect.arrayContaining([
    'chart/bench/chart.md',
    'chart/bench/demo-crosschart/chart.md',
    'chart/bench/another-crosschart/chart.md',
  ]));
  expect(incrementalArtifacts).toEqual(fullArtifacts);
});
