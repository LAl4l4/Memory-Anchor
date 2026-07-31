import * as path from 'node:path';
import { runParse } from './parse/runParse.js';
import { runReverseDependency } from './reverse/runReverseDependency.js';
import { partition } from './partition/runPartitioner.js';
import { PARTITIONED_CHART_INDEX_NAME, runRender } from './render/runRender.js';
import { destroyPool } from './parse/ASTParser.js';
import { logToUser } from './shared/utils.js';
import type { BuildDirectoryTreeRegistryOptions } from './partition/partitioner.js';
import type { DirectoryTreeNode } from './partition/directoryTree.js';

export { destroyPool };

export interface BuildChartResult {
    root: DirectoryTreeNode;
    directories: string[];
    chartPaths: string[];
    indexPath: string;
}

const BUILD_STAGE_COUNT = 4;

function logStageEnd(stage: number, name: string, startedAt: bigint): void {
    const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logToUser(
        `[Stage ${stage}/${BUILD_STAGE_COUNT}] ${name} finished in ${elapsedMilliseconds.toFixed(2)}ms`,
        '32'
    );
}

/**
 * External full-build orchestrator. Composes the four pipeline stages with
 * explicit data hand-off so each stage stays independently invocable:
 *   runParse → runReverseDependency → partition → runRender
 */
export async function buildChart(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<BuildChartResult> {
    const parseStartedAt = process.hrtime.bigint();
    const parsed = await runParse(options);
    logStageEnd(1, 'parse', parseStartedAt);

    const reverseDependencyStartedAt = process.hrtime.bigint();
    const globalDependencyRegistry = options.globalDependencyRegistry
        ?? await runReverseDependency(parsed);
    logStageEnd(2, 'reverse dependency', reverseDependencyStartedAt);

    const partitionStartedAt = process.hrtime.bigint();
    const topology = await partition({
        ...parsed,
        globalDependencyRegistry,
        registryPath: options.registryPath,
        thresholds: options.thresholds,
    });
    logStageEnd(3, 'partition', partitionStartedAt);

    const renderStartedAt = process.hrtime.bigint();
    const chartPaths = await runRender({
        ...parsed,
        globalDependencyRegistry,
        ...topology,
    });
    logStageEnd(4, 'render', renderStartedAt);

    const indexPath = path.join(
        parsed.projectRoot,
        '.memoryanchor',
        PARTITIONED_CHART_INDEX_NAME
    );

    return { root: topology.root, directories: topology.directories, chartPaths, indexPath };
}

/** Full-build compatibility entry used by initialization and CLI hooks. */
export async function buildChartFull(): Promise<void> {
    logToUser("Compiling partitioned repository architecture...", "36");

    try {
        const result = await buildChart();
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

/** Partition-only entry: build the directory-tree registry and return its root. */
export async function buildDirectoryTreeRegistry(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<DirectoryTreeNode> {
    const { root } = await buildChart(options);
    return root;
}

/** Debug partition entry. Always destroys the parser pool so the process can exit. */
export async function buildDirectoryTreeRegistryForDebug(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<DirectoryTreeNode> {
    try {
        return await buildDirectoryTreeRegistry(options);
    } finally {
        await destroyPool();
    }
}

/** Debug end-to-end entry. Always destroys the parser pool before returning. */
export async function buildChartForDebug(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<BuildChartResult> {
    try {
        return await buildChart(options);
    } finally {
        await destroyPool();
    }
}
