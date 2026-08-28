import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    createDependencyPaths,
    getChartFileNodes,
    primeChartParseCache,
    renderChartContent,
} from './chartContentBuilder.js';
import type { DependencyPathLookup } from '../reverse/dependencyGraph.js';
import type {
    ChartParseCache,
    ChartRenderResult,
    ChartRenderTask,
    ChartRenderTiming,
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
    return `- \`${getChartWorkspacePath(directory)}\``;
}

function buildChildChartsSection(directories: readonly string[]): string {
    if (directories.length === 0) return '';
    return `## Child Charts

${directories.map(directory => {
        const label = directory === '.' ? 'repository root' : `${path.posix.basename(directory)}/`;
        return `- \`${label}\` → \`${getChartWorkspacePath(directory)}\``;
    }).join('\n')}`;
}

function findParentChart(
    directory: string,
    chartChildren: ReadonlyMap<string, readonly string[]> | undefined
): string | undefined {
    if (!chartChildren) return undefined;
    for (const [parent, children] of chartChildren) {
        if (children.includes(directory)) return parent;
    }
    return undefined;
}

function buildChartMetadata(
    directory: string,
    shallow: boolean,
    fileCount: number,
    parentChart?: string
): string {
    const scope = shallow
        ? directory === '.' ? '/' : `${directory}/`
        : directory === '.' ? '/**' : `${directory}/**`;
    const mode = shallow ? 'shallow (direct files only)' : 'recursive frontier';
    const parent = parentChart === undefined
        ? 'none (entry chart)'
        : `\`${getChartWorkspacePath(parentChart)}\``;
    return `> Chart: \`${getChartWorkspacePath(directory)}\`
> Scope: \`${scope}\` · Mode: ${mode} · Files: ${fileCount}
> Parent: ${parent}`;
}

function getPartitionOutputRoot(projectRoot: string): string {
    return path.join(projectRoot, '.memoryanchor', PARTITIONED_CHART_DIRECTORY_NAME);
}

function elapsedMilliseconds(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function sumRenderTimings(results: readonly { timing?: ChartRenderTiming }[]): ChartRenderTiming {
    return results.reduce<ChartRenderTiming>((total, result) => {
        const timing = result.timing;
        if (!timing) return total;
        total.dependencyMs += timing.dependencyMs;
        total.skeletonMs += timing.skeletonMs;
        total.nodesMs += timing.nodesMs;
        total.assemblyMs += timing.assemblyMs;
        total.writeMs += timing.writeMs;
        return total;
    }, {
        dependencyMs: 0,
        skeletonMs: 0,
        nodesMs: 0,
        assemblyMs: 0,
        writeMs: 0,
    });
}

async function preparePartitionedChart(
    directory: string,
    projectRoot: string,
    outputRoot: string,
    parseCache: ChartParseCache,
    childCharts: readonly string[] = [],
    shallow = false,
    parentChart?: string
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
    const fileNodes = getChartFileNodes(dirGroups, sourceDirectory, parseCache);

    return {
        chartPath,
        sourceDirectory,
        dirGroups: [...dirGroups.entries()],
        // Structured-clone into the worker makes each graph inversion task
        // independent: it cannot mutate the build-scoped parse cache.
        fileNodes,
        chartHeading: `Architecture: ${directory === '.' ? 'repository root' : directory}`,
        chartMetadata: buildChartMetadata(directory, shallow, fileNodes.length, parentChart),
        childChartsSection,
        chartDirectory: directory,
        writeOutput: true,
    };
}

/**
 * Render in-process so the full reverse registry and parsed nodes remain on
 * one V8 heap. Small partition tasks cost substantially more to
 * structured-clone into workers than to render.
 */
function renderPartitionedChart(
    task: ChartRenderTask,
    dependencyPaths: DependencyPathLookup,
    globalDependencyRegistry?: GlobalDependencyRegistry
): ChartRenderResult {
    const timing: ChartRenderTiming = {
        dependencyMs: 0,
        skeletonMs: 0,
        nodesMs: 0,
        assemblyMs: 0,
        writeMs: 0,
    };
    const content = renderChartContent(
        new Map(task.dirGroups),
        task.fileNodes,
        task.chartHeading,
        dependencyPaths,
        globalDependencyRegistry,
        task.chartDirectory,
        timing,
        task.chartMetadata
    );
    const assemblyStartedAt = process.hrtime.bigint();
    const chartContent = task.childChartsSection
        ? `${content.trimEnd()}\n\n${task.childChartsSection}\n`
        : content;
    timing.assemblyMs += elapsedMilliseconds(assemblyStartedAt);

    if (task.writeOutput) {
        if (!task.chartPath) throw new Error('Chart output path is required');
        const writeStartedAt = process.hrtime.bigint();
        fs.mkdirSync(path.dirname(task.chartPath), { recursive: true });
        fs.writeFileSync(task.chartPath, chartContent, 'utf-8');
        timing.writeMs = elapsedMilliseconds(writeStartedAt);
    }

    return { chartPath: task.chartPath, contentLength: chartContent.length, timing };
}

/**
 * Adapt root-relative dependency paths to one chart's local paths without
 * allocating another full Set or re-relativizing every repository file.
 */
function createScopedDependencyPathLookup(
    rootDependencyPaths: ReadonlySet<string>,
    chartDirectory: string
): DependencyPathLookup {
    const normalizedDirectory = chartDirectory.split(path.sep).join('/');
    if (normalizedDirectory === '.') return rootDependencyPaths;

    return {
        has(candidate: string): boolean {
            return rootDependencyPaths.has(path.posix.normalize(
                path.posix.join(normalizedDirectory, candidate)
            ));
        },
    };
}

export async function writeChartSet(
    directories: readonly string[],
    projectRoot: string,
    outputRoot: string,
    options: CreatePartitionedChartsOptions
): Promise<string[]> {
    const preparationStartedAt = process.hrtime.bigint();
    const parseCache = options.parseCache ?? new Map();
    const tasks: ChartRenderTask[] = [];
    for (const directory of directories) {
        tasks.push(await preparePartitionedChart(
            directory,
            projectRoot,
            outputRoot,
            parseCache,
            options.chartChildren?.get(directory) ?? [],
            options.shallowDirectories?.has(directory) ?? false,
            findParentChart(directory, options.chartChildren)
        ));
    }
    const preparationMs = elapsedMilliseconds(preparationStartedAt);
    const taskFileCount = tasks.reduce((total, task) => total + task.fileNodes.length, 0);
    logToUser(
        `[Render] prepared ${tasks.length} chart tasks / ${taskFileCount} file nodes in ${preparationMs.toFixed(2)}ms`,
        '36'
    );

    // Rendering is intentionally in-process. Passing 3,000+ small tasks and
    // a project-wide Map registry across worker isolates dwarfs the CPU work.
    logToUser(`Rendering ${tasks.length} partition charts...`, '36');
    const dependencyFiles = options.dependencyFiles ?? listParseableProjectFiles(projectRoot);
    const rootDependencyPaths = createDependencyPaths(dependencyFiles, projectRoot);
    const renderStartedAt = process.hrtime.bigint();
    const results = tasks.map(task => {
        const dependencyPaths = createScopedDependencyPathLookup(
            rootDependencyPaths,
            task.chartDirectory ?? '.'
        );
        return renderPartitionedChart(task, dependencyPaths, options.globalDependencyRegistry);
    });
    const renderWallMs = elapsedMilliseconds(renderStartedAt);
    const renderTiming = sumRenderTimings(results);
    const maxTaskMs = results.reduce((maximum, result) => {
        if (!result.timing) return maximum;
        return Math.max(
            maximum,
            result.timing.dependencyMs +
            result.timing.skeletonMs +
            result.timing.nodesMs +
            result.timing.assemblyMs +
            result.timing.writeMs
        );
    }, 0);
    logToUser(
        `[Render] in-process wall=${renderWallMs.toFixed(2)}ms, ` +
        `cpu-sum dependency=${renderTiming.dependencyMs.toFixed(2)}ms ` +
        `skeleton=${renderTiming.skeletonMs.toFixed(2)}ms ` +
        `nodes=${renderTiming.nodesMs.toFixed(2)}ms ` +
        `assembly=${renderTiming.assemblyMs.toFixed(2)}ms ` +
        `write=${renderTiming.writeMs.toFixed(2)}ms, ` +
        `max-task=${maxTaskMs.toFixed(2)}ms`,
        '36'
    );
    return results.map(({ chartPath }) => chartPath!);
}

export function writePartitionIndex(projectRoot: string, directories: readonly string[]): string {
    const indexPath = path.join(projectRoot, '.memoryanchor', PARTITIONED_CHART_INDEX_NAME);
    fs.writeFileSync(indexPath, buildPartitionedChartIndex(directories), 'utf-8');
    return indexPath;
}

export function buildPartitionedChartIndex(directories: readonly string[]): string {
    const partitions = directories.map(buildChartReference).join('\n');

    return `# Project Chart Index

> Start with the entry chart closest to the task, then follow its Child Charts until the scope matches.
> Listed chart paths are authoritative; physical directories do not necessarily own charts.

Legend: \`+\` exported · \`-\` internal · \`->\` imports · \`<-\` callers · \`[Lx-y]\` source range

## Entry Charts

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

    const resetStartedAt = process.hrtime.bigint();
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    logToUser(`[Render] reset chart output in ${elapsedMilliseconds(resetStartedAt).toFixed(2)}ms`, '36');

    const chartPaths = await writeChartSet(
        selectedDirectories,
        projectRoot,
        outputRoot,
        { ...options, dependencyFiles }
    );

    const indexStartedAt = process.hrtime.bigint();
    fs.rmSync(legacyChartPath, { force: true });
    writePartitionIndex(projectRoot, options.rootDirectories ?? selectedDirectories);
    logToUser(`[Render] wrote chart index in ${elapsedMilliseconds(indexStartedAt).toFixed(2)}ms`, '36');

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
