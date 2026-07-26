import * as path from 'node:path';
import { batchParseFiles } from './ASTParser.js';
import {
    applyGlobalReverseDependencies,
    buildChartDependencyGraph,
    GlobalDependencyRegistry,
    resolveFileDependencies,
} from './dependencyGraph.js';
import { buildNodesSection } from './nodesEditor.js';
import { buildSkeletonSection } from './skeletonEditor.js';
import { FileNode } from './symbolExtractor.js';
import { listParseableProjectFiles, PROJECT_ROOT } from './utils.js';

export type ChartParseCache = Map<string, FileNode>;

/** Normalize repository files once for reuse across multiple chart renders. */
export function createDependencyPaths(
    dependencyFiles: readonly string[],
    projectRoot: string
): ReadonlySet<string> {
    return new Set(dependencyFiles.map(file =>
        path.relative(projectRoot, file).split(path.sep).join('/')
    ));
}

export interface ChartFile {
    absolutePath: string;
    relativePath: string;
}

export function getChartFiles(
    dirGroups: Map<string, string[]>,
    projectRoot: string
): ChartFile[] {
    const sortedDirs = [...dirGroups.keys()].sort((a, b) => a.localeCompare(b));
    const files: ChartFile[] = [];

    for (const dir of sortedDirs) {
        for (const relativePath of [...dirGroups.get(dir)!].sort()) {
            files.push({
                absolutePath: path.resolve(projectRoot, relativePath),
                relativePath,
            });
        }
    }

    return files;
}

/** Materialize a chart-local, independently mutable view of cached AST data. */
export function getChartFileNodes(
    dirGroups: Map<string, string[]>,
    projectRoot: string,
    parseCache: ReadonlyMap<string, FileNode>
): FileNode[] {
    return getChartFiles(dirGroups, projectRoot).map(({ absolutePath, relativePath }) => ({
        ...parseCache.get(absolutePath)!,
        relativePath,
    }));
}

/** Parse every cache miss in one batch so the lazy worker pool can parallelize it. */
export async function primeChartParseCache(
    dirGroups: Map<string, string[]>,
    projectRoot: string = PROJECT_ROOT,
    parseCache: ChartParseCache = new Map()
): Promise<ChartParseCache> {
    const uniqueMisses = new Map<string, ChartFile>();
    for (const file of getChartFiles(dirGroups, projectRoot)) {
        if (!parseCache.has(file.absolutePath)) uniqueMisses.set(file.absolutePath, file);
    }

    const misses = [...uniqueMisses.values()];
    const parsed = await batchParseFiles(misses);
    misses.forEach((file, index) => parseCache.set(file.absolutePath, parsed[index]));
    return parseCache;
}

/** Build one chart document from an already-grouped set of project files. */
export async function buildChartContent(
    dirGroups: Map<string, string[]>,
    projectRoot: string = PROJECT_ROOT,
    parseCache: ChartParseCache = new Map(),
    chartHeading: string = 'PROJECT CHART',
    dependencyFiles: readonly string[] = listParseableProjectFiles(projectRoot),
    dependencyPaths?: ReadonlySet<string>
): Promise<string> {
    await primeChartParseCache(dirGroups, projectRoot, parseCache);
    return renderChartContent(
        dirGroups,
        getChartFileNodes(dirGroups, projectRoot, parseCache),
        chartHeading,
        dependencyPaths ?? createDependencyPaths(dependencyFiles, projectRoot)
    );
}

/**
 * CPU-only chart rendering. Its FileNodes are intentionally mutable because
 * dependency inversion annotates them; callers must provide task-local nodes.
 */
export function renderChartContent(
    dirGroups: Map<string, string[]>,
    fileNodes: FileNode[],
    chartHeading: string,
    dependencyPaths: ReadonlySet<string>,
    globalDependencyRegistry?: GlobalDependencyRegistry,
    chartDirectory: string = '.'
): string {
    const graphNodes = globalDependencyRegistry
        ? (() => {
            resolveFileDependencies(fileNodes, dependencyPaths);
            return applyGlobalReverseDependencies(fileNodes, globalDependencyRegistry, chartDirectory);
        })()
        : buildChartDependencyGraph(fileNodes, dependencyPaths);
    const skeletonSection = buildSkeletonSection(dirGroups, graphNodes);
    const nodesSection = buildNodesSection(graphNodes);

    return `# ${chartHeading}\n\n${skeletonSection}\n\n${nodesSection}`;
}
