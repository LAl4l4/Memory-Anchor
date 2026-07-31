#!/usr/bin/env node
import { updatePartitionedChartIncrementally } from '../../chartBuild/incremental.js';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';

async function refreshChart(changes: GitChange[] | null): Promise<void> {
  if (!changes || changes.length === 0) {
    return;
  }

  const changedPaths = changes.map((c) => c.file);
  await updatePartitionedChartIncrementally(changedPaths);
}

export async function runStop(): Promise<void> {
  const changes = captureGitChanges();
  await refreshChart(changes);
  process.exit(0);
}
