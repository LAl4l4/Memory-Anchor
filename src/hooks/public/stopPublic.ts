#!/usr/bin/env node
import { updateChartIncrementally } from '../../core/build-chart.js';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';

async function refreshChart(changes: GitChange[] | null): Promise<void> {
  // this function should never call buildChartFull, it should only called in fallback 
  // or anchor init command
  if (!changes || changes.length === 0) {
    return;
  }

  const changedPaths = changes.map((c) => c.file);
  await updateChartIncrementally(changedPaths);
}

export async function runStop(): Promise<void> {
  const changes = captureGitChanges();
  await refreshChart(changes);
  process.exit(0);
}
