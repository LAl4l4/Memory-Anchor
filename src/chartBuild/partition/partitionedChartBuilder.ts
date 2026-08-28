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
    /** Existing owners whose source or reverse-call content changed in this batch. */
    additionalDirectories?: readonly string[];
}

/** Exact output work performed while reconciling an incremental topology change. */
export interface TopologyRebuildResult {
    chartPaths: string[];
    renderedDirectories: string[];
    /** Former owners whose generated chart file was removed. */
    removedDirectories: string[];
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

function getChartParent(
    directory: string,
    topology: ChartTopologySnapshot
): string | null {
    for (const [parent, children] of topology.chartChildren) {
        if (children.includes(directory)) return parent;
    }
    return null;
}

function sameChartParent(
    directory: string,
    previous: ChartTopologySnapshot,
    next: ChartTopologySnapshot
): boolean {
    return getChartParent(directory, previous) === getChartParent(directory, next);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Whether a physical-tree mutation changes chart ownership or routing. */
export function hasChartTopologyChanged(
    previous: ChartTopologySnapshot,
    next: ChartTopologySnapshot
): boolean {
    if (!sameStringList(previous.directories, next.directories) ||
        !sameStringList(previous.rootDirectories, next.rootDirectories) ||
        previous.shallowDirectories.size !== next.shallowDirectories.size) {
        return true;
    }
    for (const directory of previous.shallowDirectories) {
        if (!next.shallowDirectories.has(directory)) return true;
    }

    const directories = new Set([
        ...previous.chartChildren.keys(),
        ...next.chartChildren.keys(),
    ]);
    for (const directory of directories) {
        if (!sameChartChildren(directory, previous, next)) return true;
    }
    return false;
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
        !isInsideBoundary(directory) && (
            !sameChartChildren(directory, previous, next) ||
            !sameChartParent(directory, previous, next)
        )
    );
    return [...localDirectories, ...externalParents];
}

/**
 * Return only charts whose ownership, direct-file scope, or child routing
 * changed between two topology snapshots. Content-only chart updates are
 * supplied separately by the incremental caller.
 */
function getTopologyRebuildDirectories(
    previous: ChartTopologySnapshot,
    next: ChartTopologySnapshot
): string[] {
    const previousDirectories = new Set(previous.directories);
    const directories = new Set<string>();

    for (const directory of next.directories) {
        if (!previousDirectories.has(directory) ||
            previous.shallowDirectories.has(directory) !== next.shallowDirectories.has(directory) ||
            !sameChartChildren(directory, previous, next) ||
            !sameChartParent(directory, previous, next)) {
            directories.add(directory);
        }
    }

    // Parent changes alter rendered chart metadata even when the chart's own
    // files and children are unchanged. Root-directory changes still affect
    // index.md without requiring unrelated chart bodies to be regenerated.
    return next.directories.filter(directory => directories.has(directory));
}

function getRemovedTopologyDirectories(
    previous: ChartTopologySnapshot,
    next: ChartTopologySnapshot
): string[] {
    const nextDirectories = new Set(next.directories);
    return previous.directories.filter(directory => !nextDirectories.has(directory));
}

function resetBoundaryOutput(outputRoot: string, boundaryDirectory: string): void {
    const affectedOutput = path.join(outputRoot, boundaryDirectory);
    fs.rmSync(affectedOutput, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });
}

function getChartOutputPath(outputRoot: string, directory: string): string {
    return path.join(directory === '.' ? outputRoot : path.join(outputRoot, directory), 'chart.md');
}

/** Remove a stale chart without deleting siblings that share an output parent. */
function removeChartOutput(outputRoot: string, directory: string): boolean {
    const chartPath = getChartOutputPath(outputRoot, directory);
    if (!fs.existsSync(chartPath)) return false;

    fs.rmSync(chartPath, { force: true });
    if (directory === '.') return true;

    let currentDirectory = path.dirname(chartPath);
    while (currentDirectory !== outputRoot) {
        if (fs.readdirSync(currentDirectory).length > 0) break;
        fs.rmdirSync(currentDirectory);
        currentDirectory = path.dirname(currentDirectory);
    }
    return true;
}

function getTopologyChartOptions(
    topology: ChartTopologySnapshot,
    options: CreatePartitionedChartsOptions = {}
): CreatePartitionedChartsOptions {
    return {
        parseCache: options.parseCache,
        shallowDirectories: topology.shallowDirectories,
        chartChildren: topology.chartChildren,
        rootDirectories: topology.rootDirectories,
        dependencyFiles: options.dependencyFiles,
        globalDependencyRegistry: options.globalDependencyRegistry,
    };
}

function rebuildCompleteTopology(
    topology: ChartTopologySnapshot,
    projectRoot: string,
    options: CreatePartitionedChartsOptions = {}
): Promise<string[]> {
    return createPartitionedCharts(topology.directories, {
        projectRoot,
        ...getTopologyChartOptions(topology, options),
    });
}

/**
 * Reconcile an incremental topology mutation by rewriting only changed chart
 * owners and removing only former owners. This deliberately avoids deriving a
 * broad physical boundary from an unrelated batch of changed files.
 */
export async function rebuildChangedPartitionCharts(
    previousTopology: ChartTopologySnapshot,
    nextTopology: ChartTopologySnapshot,
    options: RebuildPartitionBoundaryOptions = {}
): Promise<TopologyRebuildResult> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const outputRoot = path.join(
        projectRoot,
        '.memoryanchor',
        PARTITIONED_CHART_DIRECTORY_NAME
    );
    const requestedDirectories = new Set([
        ...getTopologyRebuildDirectories(previousTopology, nextTopology),
        ...(options.additionalDirectories ?? []),
    ]);
    const renderedDirectories = nextTopology.directories.filter(directory =>
        requestedDirectories.has(directory)
    );
    const removedDirectories = getRemovedTopologyDirectories(
        previousTopology,
        nextTopology
    ).filter(directory => removeChartOutput(outputRoot, directory));
    const chartPaths = renderedDirectories.length === 0
        ? []
        : await writeChartSet(
            renderedDirectories,
            projectRoot,
            outputRoot,
            getTopologyChartOptions(nextTopology, {
                ...options,
                dependencyFiles: options.dependencyFiles ?? listParseableProjectFiles(projectRoot),
            })
        );

    writePartitionIndex(projectRoot, nextTopology.rootDirectories);
    return { chartPaths, renderedDirectories, removedDirectories };
}

/** Compatibility entry: rebuild the virtual chart set after a topology change. */
export async function rebuildPartitionBoundary(
    root: DirectoryTreeNode,
    boundary: DirectoryTreeNode | string,
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
        return rebuildCompleteTopology(nextTopology, projectRoot, options);
    }

    const outputRoot = path.join(
        projectRoot,
        '.memoryanchor',
        PARTITIONED_CHART_DIRECTORY_NAME
    );
    const boundaryDirectory = typeof boundary === 'string'
        ? boundary
        : boundary.directory;
    const topologyDirectories = getBoundaryRebuildDirectories(
        boundaryDirectory,
        previousTopology,
        nextTopology
    );
    const requestedDirectories = new Set([
        ...topologyDirectories,
        ...(options.additionalDirectories ?? []),
    ]);
    const rebuildDirectories = nextTopology.directories.filter(directory =>
        requestedDirectories.has(directory)
    );
    const parseCache = options.parseCache ?? new Map();
    resetBoundaryOutput(outputRoot, boundaryDirectory);
    const chartPaths = await writeChartSet(
        rebuildDirectories,
        projectRoot,
        outputRoot,
        {
            ...getTopologyChartOptions(nextTopology, {
                ...options,
                parseCache,
                dependencyFiles: options.dependencyFiles ?? listParseableProjectFiles(projectRoot),
            }),
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
