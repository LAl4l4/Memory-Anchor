import * as path from 'node:path';
import { batchParseFiles } from '../parse/ASTParser.js';
import {
    applyGlobalReverseDependencies,
    buildChartDependencyGraph,
    resolveFileDependencies,
    type DependencyPathLookup,
} from '../reverse/dependencyGraph.js';
import { buildArchitectureSection } from './architectureEditor.js';
import type {
    ChartFile,
    ChartParseCache,
    ChartRenderTiming,
    FileNode,
    GlobalDependencyRegistry,
} from '../shared/CBHTypes.js';
import { listParseableProjectFiles, PROJECT_ROOT } from '../shared/utils.js';

export type { ChartFile, ChartParseCache } from '../shared/CBHTypes.js';

/** Normalize repository files once for reuse across multiple chart renders. */
export function createDependencyPaths(
    dependencyFiles: readonly string[],
    projectRoot: string
): ReadonlySet<string> {
    return new Set(dependencyFiles.map(file =>
        path.relative(projectRoot, file).split(path.sep).join('/')
    ));
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
        // Rendering resolves imports and assigns reverse callers. Keep those
        // mutable fields local so a later chart cannot alter the shared cache.
        symbols: parseCache.get(absolutePath)!.symbols.map(symbol => ({
            ...symbol,
            forwardDependencies: [...symbol.forwardDependencies],
            dependedOnBy: [...symbol.dependedOnBy],
        })),
        dependencies: parseCache.get(absolutePath)!.dependencies.map(dependency => ({
            ...dependency,
            bindings: dependency.bindings.map(binding => ({ ...binding })),
        })),
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
    dependencyPaths: DependencyPathLookup,
    globalDependencyRegistry?: GlobalDependencyRegistry,
    chartDirectory: string = '.',
    timing?: Partial<ChartRenderTiming>,
    chartMetadata: string = ''
): string {
    const dependencyStartedAt = process.hrtime.bigint();
    const graphNodes = globalDependencyRegistry
        ? (() => {
            resolveFileDependencies(fileNodes, dependencyPaths);
            return applyGlobalReverseDependencies(fileNodes, globalDependencyRegistry, chartDirectory);
        })()
        : buildChartDependencyGraph(fileNodes, dependencyPaths);
    timing && (timing.dependencyMs = Number(process.hrtime.bigint() - dependencyStartedAt) / 1_000_000);

    const architectureStartedAt = process.hrtime.bigint();
    const architectureSection = buildArchitectureSection(dirGroups, graphNodes);
    timing && (timing.architectureMs = Number(process.hrtime.bigint() - architectureStartedAt) / 1_000_000);

    const assemblyStartedAt = process.hrtime.bigint();
    const sections = [`# ${chartHeading}`];
    if (chartMetadata) sections.push(chartMetadata);
    sections.push(architectureSection);
    const content = `${sections.join('\n\n')}\n`;
    timing && (timing.assemblyMs = Number(process.hrtime.bigint() - assemblyStartedAt) / 1_000_000);
    return content;
}
