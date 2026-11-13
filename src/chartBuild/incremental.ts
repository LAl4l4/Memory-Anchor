import { buildChartFull } from './buildChart.js';
import { updatePartitionedChartsIncrementally } from './partition/incrementalPartitioner.js';
import { appendDebugLog, formatError } from '../utils/logger.js';
import { getIgnorePolicyChanges, IgnorePolicy } from '../utils/ignorePolicy.js';

/**
 * Update only the affected directory partition and its ancestor character
 * totals. Falls back to a partitioned full build when registry topology is
 * unavailable or ignore rules have changed.
 */
export async function updatePartitionedChartIncrementally(
    changedFiles: string[]
): Promise<void> {
    const policy = new IgnorePolicy(process.cwd());
    const files = changedFiles.filter((file) => !policy.isIgnored(file));
    if (files.length === 0 && getIgnorePolicyChanges(process.cwd(), changedFiles).length === 0) {
        appendDebugLog('debug', 'Incremental refresh skipped: no non-ignored changed files.');
        return;
    }

    appendDebugLog(
        'debug',
        `Incremental refresh requested for ${files.length} file(s): ${files.join(', ')}`
    );

    try {
        const updated = await updatePartitionedChartsIncrementally(changedFiles);
        if (!updated) {
            appendDebugLog(
                'warn',
                'Incremental refresh fell back to a full build because persistent state is unavailable or ignore rules changed.'
            );
            await buildChartFull();
            return;
        }
        appendDebugLog('debug', 'Incremental refresh completed without a full-build fallback.');
    } catch (error) {
        appendDebugLog('error', `Incremental refresh failed:\n${formatError(error)}`);
        throw error;
    }
}

/** Backward-compatible name for callers of the original incremental updater. */
export const updateChartIncrementally = updatePartitionedChartIncrementally;
