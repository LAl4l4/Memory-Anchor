#!/usr/bin/env node
import { acknowledgeGitChanges, captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';
import { updatePartitionedChartIncrementally } from '../../chartBuild/incremental.js';
import { destroyPool } from '../../chartBuild/buildChart.js';
import { logToUser } from '../../chartBuild/shared/utils.js';
import { appendDebugLog, formatError } from '../../utils/logger.js';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from './hookDebug.js';

export { sanitizeGuardrails } from './guardrailMaintenance.js';

export function updateProjectState(changes: GitChange[] | null): void {
  if (!changes || changes.length === 0) return;

  const parts: string[] = [];
  changes.forEach((c: GitChange) => {
    const statusMap: Record<string, string> = { M: 'Modified', A: 'Added', '??': 'Untracked' };
    const action = statusMap[c.status] || 'Changed';
    parts.push(`\`${c.file}\` (${action})`);
  });

  logToUser(`Code changes captured: ${parts.join('; ')}`, '36');
}

export async function runSessionEnd(): Promise<void> {
  const invocation = logHookTriggered(getHookInvocation());
  try {
    const changes = captureGitChanges();
    if (!changes || changes.length === 0) {
      appendDebugLog('debug', 'Session-end refresh skipped: no changes since the last successful refresh.');
      logHookSucceeded(invocation, 'skipped: no changes since the last successful refresh');
    } else {
      appendDebugLog('debug', `Session-end refresh captured ${changes.length} Git change(s).`);
      updateProjectState(changes);

      const changedPaths = changes.map((c) => c.file);
      await updatePartitionedChartIncrementally(changedPaths);
      acknowledgeGitChanges(changes);
      appendDebugLog('debug', 'Session-end refresh completed.');
      logHookSucceeded(
        invocation,
        `session maintenance and incremental refresh completed for ${changes.length} Git change(s)`,
      );
    }
  } catch (error) {
    const message = `Session-end refresh failed: ${error instanceof Error ? error.message : error}`;
    logToUser(message, '31');
    appendDebugLog('error', `${message}\n${formatError(error)}`);
    logHookFailed(invocation, error);
    throw error;
  } finally {
    await destroyPool();
  }
  process.exit(0);
}
