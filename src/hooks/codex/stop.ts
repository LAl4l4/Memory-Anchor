#!/usr/bin/env node
import { buildChartFull, updateChartIncrementally } from '../../core/build-chart.js';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';

async function refreshChart(changes: GitChange[] | null): Promise<void> {
  if (!changes || changes.length === 0) {
    await buildChartFull();
    return;
  }

  const changedPaths = changes.map((c) => c.file);
  await updateChartIncrementally(changedPaths);
}

async function main(): Promise<void> {
  const changes = captureGitChanges();
  await refreshChart(changes);
  process.exit(0);
}

void main();
