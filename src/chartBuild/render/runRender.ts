import * as fs from 'node:fs';
import * as path from 'node:path';
import { WORKER_THREAD_POOL_SIZE } from '../parse/ASTParser.js';
import { ChartWorkerPool } from './chartPool.js';
import { getChartFileNodes, primeChartParseCache } from './chartContentBuilder.js';
import type {
    ChartParseCache,
    ChartRenderTask,
    GlobalDependencyRegistry,
} from '../shared/CBHTypes.js';
import { listParseableProjectFiles, listProjectFiles, logToUser, resolveWorkspacePaths } from '../shared/utils.js';

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

export async function writeChartSet(
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

export function writePartitionIndex(projectRoot: string, directories: readonly string[]): string {
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

export interface RenderStageOptions {
    projectRoot: string;
    parseCache: ChartParseCache;
    globalDependencyRegistry: GlobalDependencyRegistry;
    dependencyFiles: string[];
    directories: string[];
    shallowDirectories: ReadonlySet<string>;
    chartChildren: ReadonlyMap<string, readonly string[]>;
    rootDirectories: readonly string[];
}

/**
 * Stage 4: render every partition chart (and the index) from the topology
 * produced by the partition stage.
 */
export async function runRender(options: RenderStageOptions): Promise<string[]> {
    return createPartitionedCharts(options.directories, {
        projectRoot: options.projectRoot,
        parseCache: options.parseCache,
        shallowDirectories: options.shallowDirectories,
        chartChildren: options.chartChildren,
        rootDirectories: options.rootDirectories,
        dependencyFiles: options.dependencyFiles,
        globalDependencyRegistry: options.globalDependencyRegistry,
    });
}
