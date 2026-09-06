#!/usr/bin/env node
import { updatePartitionedChartIncrementally } from '../../chartBuild/incremental.js';
import { acknowledgeGitChanges, captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';
import { appendDebugLog, formatError } from '../../utils/logger.js';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from './hookDebug.js';

async function refreshChart(changes: GitChange[] | null): Promise<string> {
  if (!changes || changes.length === 0) {
    appendDebugLog('debug', 'Stop refresh skipped: no changes since the last successful refresh.');
    return 'skipped: no changes since the last successful refresh';
  }

  appendDebugLog('debug', `Stop refresh captured ${changes.length} Git change(s).`);
  const changedPaths = changes.map((c) => c.file);
  await updatePartitionedChartIncrementally(changedPaths);
  acknowledgeGitChanges(changes);
  appendDebugLog('debug', 'Stop refresh completed.');
  return `incremental refresh completed for ${changes.length} Git change(s)`;
}

export async function runStop(): Promise<void> {
  const invocation = logHookTriggered(getHookInvocation());
  try {
    const changes = captureGitChanges();
    const result = await refreshChart(changes);
    logHookSucceeded(invocation, result);
  } catch (error) {
    appendDebugLog('error', `Stop refresh failed:\n${formatError(error)}`);
    logHookFailed(invocation, error);
    throw error;
  }
  process.exit(0);
}
