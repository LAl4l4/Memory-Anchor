import { buildChartFull } from './buildChart.js';
import { updatePartitionedChartsIncrementally } from './partition/incrementalPartitioner.js';
import { isIgnored } from './shared/utils.js';

/**
 * Update only the affected directory partition and its ancestor character
 * totals. Falls back to a partitioned full build when registry topology is
 * unavailable.
 */
export async function updatePartitionedChartIncrementally(
    changedFiles: string[]
): Promise<void> {
    const files = changedFiles.filter((file) => !isIgnored(file));
    if (files.length === 0) return;

    const updated = await updatePartitionedChartsIncrementally(files);
    if (!updated) {
        await buildChartFull();
    }
}

/** Backward-compatible name for callers of the original incremental updater. */
export const updateChartIncrementally = updatePartitionedChartIncrementally;
