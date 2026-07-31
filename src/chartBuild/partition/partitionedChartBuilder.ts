import * as fs from 'node:fs';
import * as path from 'node:path';
import { destroyPool } from '../parse/ASTParser.js';
import { buildChart } from '../buildChart.js';
import type { BuildChartResult } from '../buildChart.js';
import {
    createPartitionedCharts,
    PARTITIONED_CHART_DIRECTORY_NAME,
    writeChartSet,
    writePartitionIndex,
} from '../render/runRender.js';
import type { CreatePartitionedChartsOptions } from '../render/runRender.js';
import type { ChartParseCache } from '../shared/CBHTypes.js';
import { listParseableProjectFiles, resolveWorkspacePaths } from '../shared/utils.js';
import { DirectoryTreeNode, rebuildChartTree } from './directoryTree.js';
import {
    BuildDirectoryTreeRegistryOptions,
    getChartChildren,
    getDirectoriesToScan,
    getRootChartDirectories,
    getShallowPartitionDirectories,
} from './partitioner.js';

// Render entry points moved to the render stage; kept here for compat.
export { createPartitionedCharts, buildPartitionedChartIndex } from '../render/runRender.js';
export {
    PARTITIONED_CHART_DIRECTORY_NAME,
    PARTITIONED_CHART_INDEX_NAME,
} from '../render/runRender.js';
export type { CreatePartitionedChartsOptions } from '../render/runRender.js';

export interface ChartTopologySnapshot {
    directories: string[];
    shallowDirectories: Set<string>;
    chartChildren: Map<string, string[]>;
    rootDirectories: string[];
}

export interface RebuildPartitionBoundaryOptions extends CreatePartitionedChartsOptions {
    previousTopology?: ChartTopologySnapshot;
}

export type PartitionedChartsBuildResult = BuildChartResult;
export type PartitionedChartsDebugResult = BuildChartResult;

/** Capture the serializable chart routing state before a split/merge mutation. */
export function captureChartTopology(root: DirectoryTreeNode): ChartTopologySnapshot {
    return {
        directories: getDirectoriesToScan(root),
        shallowDirectories: getShallowPartitionDirectories(root),
        chartChildren: getChartChildren(root),
        rootDirectories: getRootChartDirectories(root),
    };
}

function sameChartChildren(
    directory: string,
    previous: ChartTopologySnapshot,
    next: ChartTopologySnapshot
): boolean {
    const previousChildren = previous.chartChildren.get(directory) ?? [];
    const nextChildren = next.chartChildren.get(directory) ?? [];
    return previousChildren.length === nextChildren.length &&
        previousChildren.every((child, index) => child === nextChildren[index]);
}

function getBoundaryRebuildDirectories(
    boundaryDirectory: string,
    previous: ChartTopologySnapshot,
    next: ChartTopologySnapshot
): string[] {
    const isInsideBoundary = (directory: string): boolean =>
        boundaryDirectory === '.' ||
        directory === boundaryDirectory ||
        directory.startsWith(`${boundaryDirectory}/`);
    const localDirectories = next.directories.filter(isInsideBoundary);
    const externalParents = next.directories.filter(directory =>
        !isInsideBoundary(directory) && !sameChartChildren(directory, previous, next)
    );
    return [...localDirectories, ...externalParents];
}

function resetBoundaryOutput(outputRoot: string, boundaryDirectory: string): void {
    const affectedOutput = path.join(outputRoot, boundaryDirectory);
    fs.rmSync(affectedOutput, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });
}

function getTopologyChartOptions(
    topology: ChartTopologySnapshot,
    parseCache?: ChartParseCache
): CreatePartitionedChartsOptions {
    return {
        parseCache,
        shallowDirectories: topology.shallowDirectories,
        chartChildren: topology.chartChildren,
        rootDirectories: topology.rootDirectories,
    };
}

function rebuildCompleteTopology(
    topology: ChartTopologySnapshot,
    projectRoot: string,
    parseCache?: ChartParseCache
): Promise<string[]> {
    return createPartitionedCharts(topology.directories, {
        projectRoot,
        ...getTopologyChartOptions(topology, parseCache),
    });
}

/** Compatibility entry: rebuild the virtual chart set after a topology change. */
export async function rebuildPartitionBoundary(
    root: DirectoryTreeNode,
    boundary: DirectoryTreeNode,
    options: RebuildPartitionBoundaryOptions = {}
): Promise<string[]> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const previousTopology = options.previousTopology;
    rebuildChartTree(root);
    const nextTopology = captureChartTopology(root);

    // Compatibility callers that did not capture the pre-mutation topology
    // cannot safely identify stale owners, so retain the atomic full rebuild.
    if (!previousTopology) {
        return rebuildCompleteTopology(nextTopology, projectRoot, options.parseCache);
    }

    const outputRoot = path.join(
        projectRoot,
        '.memoryanchor',
        PARTITIONED_CHART_DIRECTORY_NAME
    );
    const rebuildDirectories = getBoundaryRebuildDirectories(
        boundary.directory,
        previousTopology,
        nextTopology
    );
    const parseCache = options.parseCache ?? new Map();
    resetBoundaryOutput(outputRoot, boundary.directory);
    const chartPaths = await writeChartSet(
        rebuildDirectories,
        projectRoot,
        outputRoot,
        {
            ...getTopologyChartOptions(nextTopology, parseCache),
            dependencyFiles: listParseableProjectFiles(projectRoot),
        }
    );

    writePartitionIndex(projectRoot, nextTopology.rootDirectories);
    return chartPaths;
}

/** Automatic full-build entry. Delegates to the external buildChart orchestrator. */
export async function buildPartitionedCharts(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<PartitionedChartsBuildResult> {
    return buildChart(options);
}

/** Debug end-to-end entry. Always destroys the parser pool before returning. */
export async function buildPartitionedChartsForDebug(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<PartitionedChartsDebugResult> {
    try {
        return await buildPartitionedCharts(options);
    } finally {
        await destroyPool();
    }
}
