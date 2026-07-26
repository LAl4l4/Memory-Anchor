import * as fs from 'node:fs';
import * as path from 'node:path';
import { destroyPool, WORKER_THREAD_POOL_SIZE } from '../chartBuildHelper/ASTParser.js';
import {
    ChartParseCache,
    getChartFileNodes,
    primeChartParseCache,
} from '../chartBuildHelper/chartContentBuilder.js';
import { ChartWorkerPool } from '../chartBuildHelper/chartPool.js';
import type { ChartRenderTask } from '../chartBuildHelper/chartWorker.js';
import type { GlobalDependencyRegistry } from '../chartBuildHelper/dependencyGraph.js';
import {
    listParseableProjectFiles,
    listProjectFiles,
    logToUser,
    resolveWorkspacePaths,
} from '../chartBuildHelper/utils.js';
import {
    buildDirectoryTreeRegistryWithDependencies,
    BuildDirectoryTreeRegistryOptions,
    getDirectoriesToScan,
    getRootChartDirectories,
    getShallowPartitionDirectories,
} from './partitioner.js';
import { DirectoryTreeNode, isChartOwner, rebuildChartTree } from './directoryTree.js';

export const PARTITIONED_CHART_DIRECTORY_NAME = 'chart';
export const PARTITIONED_CHART_INDEX_NAME = 'index.md';

export interface CreatePartitionedChartsOptions {
    projectRoot?: string;
    parseCache?: ChartParseCache;
    /** Split ancestor owners that contain only their direct files. */
    shallowDirectories?: ReadonlySet<string>;
    /** Immediate virtual-chart children keyed by chart directory. */
    chartChildren?: ReadonlyMap<string, readonly string[]>;
    /** First virtual-chart layer to expose in index.md. */
    rootDirectories?: readonly string[];
    /** Absolute paths available as forward dependency targets. */
    dependencyFiles?: readonly string[];
    /** Project-wide reverse edges built from the shared parse cache. */
    globalDependencyRegistry?: GlobalDependencyRegistry;
}

export interface ChartTopologySnapshot {
    directories: string[];
    shallowDirectories: Set<string>;
    chartChildren: Map<string, string[]>;
    rootDirectories: string[];
}

export interface RebuildPartitionBoundaryOptions extends CreatePartitionedChartsOptions {
    previousTopology?: ChartTopologySnapshot;
}

export interface PartitionedChartsDebugResult {
    directories: string[];
    chartPaths: string[];
    indexPath: string;
}

export type PartitionedChartsBuildResult = PartitionedChartsDebugResult;

function resolveSourceDirectory(projectRoot: string, directory: string): string {
    return directory === '.' ? projectRoot : path.join(projectRoot, directory);
}

function resolveChartDirectory(outputRoot: string, directory: string): string {
    return directory === '.' ? outputRoot : path.join(outputRoot, directory);
}

function validateDirectory(directory: string): void {
    const normalized = path.normalize(directory);
    if (
        directory.length === 0 ||
        path.isAbsolute(directory) ||
        normalized === '..' ||
        normalized.startsWith(`..${path.sep}`)
    ) {
        throw new Error(`Cannot build partitioned chart for invalid directory '${directory}'`);
    }
}

function getChartWorkspacePath(directory: string): string {
    const chartDirectory = directory === '.' ? '' : `${directory}/`;
    return `.memoryanchor/chart/${chartDirectory}chart.md`;
}

function buildChartReference(directory: string): string {
    return `### ${getChartWorkspacePath(directory)}`;
}

function buildChildChartsSection(directories: readonly string[]): string {
    if (directories.length === 0) return '';
    return `## 3. Child Charts

${directories.map(buildChartReference).join('\n\n')}`;
}

function getChartChildren(root: DirectoryTreeNode): Map<string, string[]> {
    const children = new Map<string, string[]>();
    const visit = (node: DirectoryTreeNode): void => {
        if (isChartOwner(node)) {
            children.set(
                node.directory,
                node.chartChildren.map(child => child.directory)
            );
        }
        if (!node.isSplit) return;
        for (const child of node.children) visit(child);
    };
    visit(root);
    return children;
}

/** Capture the serializable chart routing state before a split/merge mutation. */
export function captureChartTopology(root: DirectoryTreeNode): ChartTopologySnapshot {
    return {
        directories: getDirectoriesToScan(root),
        shallowDirectories: getShallowPartitionDirectories(root),
        chartChildren: getChartChildren(root),
        rootDirectories: getRootChartDirectories(root),
    };
}

function getPartitionOutputRoot(projectRoot: string): string {
    return path.join(projectRoot, '.memoryanchor', PARTITIONED_CHART_DIRECTORY_NAME);
}

async function preparePartitionedChart(
    directory: string,
    projectRoot: string,
    outputRoot: string,
    parseCache: ChartParseCache,
    childCharts: readonly string[] = [],
    shallow = false
): Promise<ChartRenderTask> {
    validateDirectory(directory);
    const sourceDirectory = resolveSourceDirectory(projectRoot, directory);
    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
        throw new Error(`Cannot build partitioned chart: directory '${directory}' does not exist`);
    }

    const dirGroups = listProjectFiles(sourceDirectory, !shallow);
    const childChartsSection = buildChildChartsSection(childCharts);
    const chartDirectory = resolveChartDirectory(outputRoot, directory);
    const chartPath = path.join(chartDirectory, 'chart.md');
    await primeChartParseCache(dirGroups, sourceDirectory, parseCache);

    return {
        chartPath,
        sourceDirectory,
        dirGroups: [...dirGroups.entries()],
        // Structured-clone into the worker makes each graph inversion task
        // independent: it cannot mutate the build-scoped parse cache.
        fileNodes: getChartFileNodes(dirGroups, sourceDirectory, parseCache),
        chartHeading: `CHART AT ${getChartWorkspacePath(directory)}`,
        childChartsSection,
        chartDirectory: directory,
        writeOutput: true,
    };
}

async function writeChartSet(
    directories: readonly string[],
    projectRoot: string,
    outputRoot: string,
    options: CreatePartitionedChartsOptions
): Promise<string[]> {
    const parseCache = options.parseCache ?? new Map();
    const tasks: ChartRenderTask[] = [];
    for (const directory of directories) {
        tasks.push(await preparePartitionedChart(
            directory,
            projectRoot,
            outputRoot,
            parseCache,
            options.chartChildren?.get(directory) ?? [],
            options.shallowDirectories?.has(directory) ?? false
        ));
    }

    // Each task owns a different chart path. Chart workers therefore perform
    // reverse-dependency analysis and file writes concurrently without locks.
    logToUser(`Rendering ${tasks.length} partition charts...`, '36');
    const pool = new ChartWorkerPool(
        options.dependencyFiles ?? listParseableProjectFiles(projectRoot),
        undefined,
        options.globalDependencyRegistry
    );
    try {
        await pool.init(WORKER_THREAD_POOL_SIZE);
        const results = await Promise.all(tasks.map(task => pool.render(task)));
        return results.map(({ chartPath }) => chartPath!);
    } finally {
        await pool.destroy();
    }
}

function writePartitionIndex(projectRoot: string, directories: readonly string[]): string {
    const indexPath = path.join(projectRoot, '.memoryanchor', PARTITIONED_CHART_INDEX_NAME);
    fs.writeFileSync(indexPath, buildPartitionedChartIndex(directories), 'utf-8');
    return indexPath;
}

export function buildPartitionedChartIndex(directories: readonly string[]): string {
    const partitions = directories.map(buildChartReference).join('\n\n');

    return `# Project Chart Index

## Usage

How to find the right chart:

1. Start with the chart paths listed under Root Partitions.
2. Open the chart whose path is closest to the task.
3. Read that chart's Child Charts section and follow only the listed paths
   when the task belongs to a more specific area.
4. Repeat until the current chart is the closest match. Every chart exposes
   its own path at the top so you can verify your location.
5. Do not guess chart paths from physical directories. A non-split frontier
   may own one recursive chart even without direct files; descendants covered
   by that chart do not own additional charts. Follow only listed paths.

## Root Partitions

${partitions}
`;
}

/**
 * Mirror selected project directories under .memoryanchor/chart. Frontier
 * charts scan recursively; split ancestor owners scan direct files only.
 */
export async function createPartitionedCharts(
    directories: readonly string[],
    options: CreatePartitionedChartsOptions = {}
): Promise<string[]> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const outputRoot = getPartitionOutputRoot(projectRoot);
    const anchorDirectory = path.dirname(outputRoot);
    const legacyChartPath = path.join(anchorDirectory, 'chart.md');
    const selectedDirectories = [...new Set(directories)];
    const dependencyFiles = options.dependencyFiles ?? listParseableProjectFiles(projectRoot);

    for (const directory of selectedDirectories) validateDirectory(directory);

    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });

    const chartPaths = await writeChartSet(
        selectedDirectories,
        projectRoot,
        outputRoot,
        { ...options, dependencyFiles }
    );

    fs.rmSync(legacyChartPath, { force: true });
    writePartitionIndex(projectRoot, options.rootDirectories ?? selectedDirectories);

    return chartPaths;
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
    const affectedOutput = resolveChartDirectory(outputRoot, boundaryDirectory);
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

    const outputRoot = getPartitionOutputRoot(projectRoot);
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

/**
 * End-to-end debug entry: build the registry, select the partition frontier,
 * emit mirrored charts, and always destroy the parser pool before returning.
 */
/** Automatic end-to-end entry. Keeps the parser pool alive for its caller. */
export async function buildPartitionedCharts(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<PartitionedChartsBuildResult> {
    const parseCache = options.parseCache ?? new Map();
    const {
        root,
        dependencyFiles,
        globalDependencyRegistry,
    } = await buildDirectoryTreeRegistryWithDependencies({ ...options, parseCache });
    const directories = getDirectoriesToScan(root);
    const chartPaths = await createPartitionedCharts(directories, {
        projectRoot: options.projectRoot,
        parseCache,
        shallowDirectories: getShallowPartitionDirectories(root),
        chartChildren: getChartChildren(root),
        rootDirectories: getRootChartDirectories(root),
        dependencyFiles,
        globalDependencyRegistry,
    });
    const projectRoot = path.resolve(options.projectRoot ?? resolveWorkspacePaths().projectRoot);
    const indexPath = path.join(
        projectRoot,
        '.memoryanchor',
        PARTITIONED_CHART_INDEX_NAME
    );

    return { directories, chartPaths, indexPath };
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
