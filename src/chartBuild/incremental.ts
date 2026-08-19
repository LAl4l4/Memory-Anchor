import { buildChartFull } from './buildChart.js';
import { updatePartitionedChartsIncrementally } from './partition/incrementalPartitioner.js';
import { isIgnored } from './shared/utils.js';
import { appendDebugLog, formatError } from '../utils/logger.js';

/**
 * Update only the affected directory partition and its ancestor character
 * totals. Falls back to a partitioned full build when registry topology is
 * unavailable.
 */
export async function updatePartitionedChartIncrementally(
    changedFiles: string[]
): Promise<void> {
    const files = changedFiles.filter((file) => !isIgnored(file));
    if (files.length === 0) {
        appendDebugLog('debug', 'Incremental refresh skipped: no non-ignored changed files.');
        return;
    }

    appendDebugLog(
        'debug',
        `Incremental refresh requested for ${files.length} file(s): ${files.join(', ')}`
    );

    try {
        const updated = await updatePartitionedChartsIncrementally(files);
        if (!updated) {
            appendDebugLog(
                'warn',
                'Incremental refresh fell back to a full build because persistent topology or dependency state is unavailable.'
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
