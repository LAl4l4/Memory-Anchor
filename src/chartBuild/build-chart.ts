// src/chartBuild/build-chart.ts
import { destroyPool } from './chartBuildHelper/ASTParser.js';
export { destroyPool } from './chartBuildHelper/ASTParser.js';
import { logToUser, isIgnored } from './chartBuildHelper/utils.js';
import { updatePartitionedChartsIncrementally } from './chartPartitioner/incrementalPartitioner.js';
import { buildPartitionedCharts } from './chartPartitioner/partitionedChartBuilder.js';

/**
 * Update only the affected directory partition and its ancestor character totals.
 * Falls back to a partitioned full build when registry topology is unavailable.
 */
export async function updatePartitionedChartIncrementally(
    changedFiles: string[]
): Promise<void> {
    const files = changedFiles.filter((f) => !isIgnored(f));
    if (files.length === 0) return;

    const updated = await updatePartitionedChartsIncrementally(files);
    if (!updated) {
        await buildChartFull();
    }
}

/** Backward-compatible name for callers of the original incremental updater. */
export const updateChartIncrementally = updatePartitionedChartIncrementally;

// async, must await
export async function buildChartFull(): Promise<void> {
    logToUser("Compiling partitioned repository architecture...", "36");

    try {
        const result = await buildPartitionedCharts();
        logToUser(
            `Partitioned chart index rendered to: .memoryanchor/index.md (${result.chartPaths.length} charts)`,
            "32"
        );
    } catch (error: any) {
        process.stderr.write(`\x1b[31m[Memory Anchor Error] Build failed: ${error?.message || error}\x1b[0m\n`);
        throw error;
    } finally {
        await destroyPool();
    }
}
