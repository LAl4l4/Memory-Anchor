import { expect } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildPartitionedChartsForDebug } from '../../dist/chartBuild/partition/partitionedChartBuilder.js';
import { updatePartitionedChartsIncrementally } from
  '../../dist/chartBuild/partition/incrementalPartitioner.js';
import type { BuildChartResult } from '../../dist/chartBuild/buildChart.js';
import type { DirectoryCharThresholds } from '../../dist/chartBuild/partition/directoryTree.js';
import { snapshotDirectory, type ArtifactSnapshot } from '../chart/testHelpers.ts';

export const UNSPLIT_THRESHOLDS: DirectoryCharThresholds = {
  splitAt: Number.MAX_SAFE_INTEGER,
  mergeAt: 0,
};

export interface ConsistencyProjects {
  fullProject: string;
  incrementalProject: string;
}

export type WorkspaceSeeder = (root: string) => Promise<void>;

export type FileChange =
  | { path: string; delete: true }
  | { path: string; content: string; delete?: false };

/**
 * Create two identical temp workspaces: one rebuilt from scratch for every
 * change batch (full side), the other updated through the incremental
 * partitioner (incremental side).
 */
export async function createConsistencyProjects(
  seedWorkspace: WorkspaceSeeder,
  label: string,
  temporaryProjects: string[]
): Promise<ConsistencyProjects> {
  const fullProject = await mkdtemp(
    path.join(os.tmpdir(), `memory-anchor-consistency-${label}-full-`)
  );
  const incrementalProject = await mkdtemp(
    path.join(os.tmpdir(), `memory-anchor-consistency-${label}-inc-`)
  );
  temporaryProjects.push(fullProject, incrementalProject);
  await seedWorkspace(fullProject);
  await seedWorkspace(incrementalProject);
  return { fullProject, incrementalProject };
}

/**
 * Give both projects the identical persisted durable state: one unsplit build
 * (used by callers to derive thresholds from measured directory chars), then
 * one build with the real thresholds. Pass the returned initial build back in
 * as `initialBuild` to skip the redundant unsplit pass.
 */
export async function buildConsistencyInitialState(
  { fullProject, incrementalProject }: ConsistencyProjects,
  thresholds: DirectoryCharThresholds,
  initialBuild: BuildChartResult | null = null
): Promise<BuildChartResult> {
  if (!initialBuild) {
    initialBuild = await buildPartitionedChartsForDebug({
      projectRoot: fullProject,
      thresholds: UNSPLIT_THRESHOLDS
    });
    await buildPartitionedChartsForDebug({
      projectRoot: incrementalProject,
      thresholds: UNSPLIT_THRESHOLDS
    });
  }
  await buildPartitionedChartsForDebug({ projectRoot: fullProject, thresholds });
  await buildPartitionedChartsForDebug({ projectRoot: incrementalProject, thresholds });
  return initialBuild;
}

/** Apply the same file mutation (add/overwrite/delete) to both projects. */
export async function applyFileChanges(
  projects: ConsistencyProjects,
  changes: readonly FileChange[]
): Promise<void> {
  for (const change of changes) {
    if (change.delete) {
      await rm(path.join(projects.fullProject, change.path), { recursive: true, force: true });
      await rm(path.join(projects.incrementalProject, change.path), { recursive: true, force: true });
      continue;
    }
    await mkdir(path.dirname(path.join(projects.fullProject, change.path)), { recursive: true });
    await mkdir(
      path.dirname(path.join(projects.incrementalProject, change.path)),
      { recursive: true }
    );
    await writeFile(path.join(projects.fullProject, change.path), change.content, 'utf8');
    await writeFile(path.join(projects.incrementalProject, change.path), change.content, 'utf8');
  }
}

/**
 * Rebuild the full project from scratch and apply the incremental update to
 * the other project, then assert both produce byte-identical `.memoryanchor`
 * artifacts (charts, index, dirTree registry, and dependency graph).
 */
export async function expectConsistentArtifacts(
  { fullProject, incrementalProject }: ConsistencyProjects,
  thresholds: DirectoryCharThresholds,
  changedFiles: string[]
): Promise<ArtifactSnapshot> {
  await buildPartitionedChartsForDebug({ projectRoot: fullProject, thresholds });
  await expect(updatePartitionedChartsIncrementally(changedFiles, {
    projectRoot: incrementalProject,
    thresholds,
  })).resolves.toBe(true);

  const fullArtifacts = await snapshotDirectory(path.join(fullProject, '.memoryanchor'));
  const incrementalArtifacts = await snapshotDirectory(
    path.join(incrementalProject, '.memoryanchor')
  );
  expect(incrementalArtifacts).toEqual(fullArtifacts);
  return fullArtifacts;
}
