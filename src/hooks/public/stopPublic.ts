#!/usr/bin/env node
import { updatePartitionedChartIncrementally } from '../../chartBuild/incremental.js';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';
import { appendDebugLog, formatError } from '../../utils/logger.js';

async function refreshChart(changes: GitChange[] | null): Promise<void> {
  if (!changes || changes.length === 0) {
    appendDebugLog('debug', 'Stop refresh skipped: Git reported no changes.');
    return;
  }

  appendDebugLog('debug', `Stop refresh captured ${changes.length} Git change(s).`);
  const changedPaths = changes.map((c) => c.file);
  await updatePartitionedChartIncrementally(changedPaths);
  appendDebugLog('debug', 'Stop refresh completed.');
}

export async function runStop(): Promise<void> {
  try {
    const changes = captureGitChanges();
    await refreshChart(changes);
  } catch (error) {
    appendDebugLog('error', `Stop refresh failed:\n${formatError(error)}`);
    throw error;
  }
  process.exit(0);
}
