import * as fs from 'node:fs';
import * as path from 'node:path';
import { destroyPool, WORKER_THREAD_POOL_SIZE } from '../chartBuildHelper/ASTParser.js';
import {
    ChartParseCache,
    createDependencyPaths,
    getChartFileNodes,
    primeChartParseCache,
} from '../chartBuildHelper/chartContentBuilder.js';
import { ChartWorkerPool } from '../chartBuildHelper/chartPool.js';
import type { ChartRenderTask } from '../chartBuildHelper/chartWorker.js';
import {
    isCodeFile,
    listProjectFiles,
    logToUser,
    resolveWorkspacePaths,
} from '../chartBuildHelper/utils.js';
import {
    createDirectoryTree,
    DIRECTORY_CHAR_THRESHOLDS,
    DirectoryCharThresholds,
    DirectoryTreeNode,
    getDeepestFirstNodes,
    isChartOwner,
    rebuildChartTree,
    toDirectoryTreeRegistry,
    validateDirectoryThresholds,
} from './directoryTree.js';

export const DIRECTORY_TREE_REGISTRY_NAME = 'dirTree.json';

export type DirectoryScanner = (
    directory: string
) => Promise<number>;

export interface BuildDirectoryTreeRegistryOptions {
    projectRoot?: string;
    registryPath?: string;
    thresholds?: DirectoryCharThresholds;
    parseCache?: ChartParseCache;
    /** Repository-relative files available as forward dependency targets. */
    dependencyPaths?: ReadonlySet<string>;
}

/**
 * Scan the deepest directories first, then roll each completed child's size
 * into its parent. Nodes over the threshold are marked as split.
 */
export async function scanDirectoryTree(
    root: DirectoryTreeNode,
    scanDirectory: DirectoryScanner,
    thresholds: DirectoryCharThresholds = DIRECTORY_CHAR_THRESHOLDS
): Promise<void> {
    validateDirectoryThresholds(thresholds);

    for (const node of getDeepestFirstNodes(root)) {
        const ownDirectoryChars = await scanDirectory(node.directory);

        const childChars = node.children.reduce(
            (total, child) => total + child.thisDirectoryChars,
            0
        );
        node.thisDirectoryChars = ownDirectoryChars + childChars;
        node.isSplit = node.thisDirectoryChars > thresholds.splitAt;
    }

    rebuildChartTree(root);
}

/** Return the threshold frontier plus shallow direct-file charts above it. */
export function getDirectoriesToScan(root: DirectoryTreeNode): string[] {
    const directories: string[] = [];

    const visit = (node: DirectoryTreeNode): void => {
        if (isChartOwner(node)) directories.push(node.directory);
        if (!node.isSplit) return;
        for (const child of node.children) visit(child);
    };

    visit(root);
    return directories;
}

/** Split ancestor charts contain only files owned directly by that directory. */
export function getShallowPartitionDirectories(root: DirectoryTreeNode): Set<string> {
    const directories = new Set<string>();
    const visit = (node: DirectoryTreeNode): void => {
        if (isChartOwner(node) && node.isSplit) directories.add(node.directory);
        if (!node.isSplit) return;
        for (const child of node.children) visit(child);
    };
    visit(root);
    return directories;
}

/** Return the first chart layer exposed by index.md. */
export function getRootChartDirectories(root: DirectoryTreeNode): string[] {
    const directories: string[] = [];
    const visit = (node: DirectoryTreeNode): void => {
        if (isChartOwner(node) && node.chartParent === null) {
            directories.push(node.directory);
        }
        if (!node.isSplit) return;
        for (const child of node.children) visit(child);
    };
    visit(root);
    return directories;
}

/** Automatic entry point. Keeps the parser pool alive for subsequent work. */
export async function buildDirectoryTreeRegistry(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<DirectoryTreeNode> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const registryPath = path.resolve(
        options.registryPath ?? path.join(projectRoot, '.memoryanchor', DIRECTORY_TREE_REGISTRY_NAME)
    );
    const dirGroups = listProjectFiles(projectRoot);
    const root = createDirectoryTree(dirGroups.keys());
    const parseCache = options.parseCache ?? new Map();
    const dependencyFiles = [...dirGroups.values()]
        .flat()
        .filter(isCodeFile)
        .map(file => path.resolve(projectRoot, file));
    const dependencyPaths = options.dependencyPaths ?? createDependencyPaths(
        dependencyFiles,
        projectRoot
    );

    // One wide batch gives the pool useful parallel work and prevents reparsing
    // the same files once per registry/chart phase.
    logToUser(`Parsing ${dependencyFiles.length} source files...`, '36');
    await primeChartParseCache(dirGroups, projectRoot, parseCache);

    const sizingTasks: { directory: string; task: ChartRenderTask }[] = [];
    for (const [directory, files] of dirGroups) {
        if (files.length === 0) continue;
        const directoryGroup = new Map<string, string[]>([[directory, files]]);
        sizingTasks.push({
            directory,
            task: {
                sourceDirectory: projectRoot,
                dirGroups: [...directoryGroup.entries()],
                fileNodes: getChartFileNodes(directoryGroup, projectRoot, parseCache),
                chartHeading: 'PROJECT CHART',
                childChartsSection: '',
                writeOutput: false,
            },
        });
    }

    const directChartLengths = new Map<string, number>();
    logToUser(`Sizing ${sizingTasks.length} directories for chart partitions...`, '36');
    const chartPool = new ChartWorkerPool(dependencyFiles, dependencyPaths);
    try {
        await chartPool.init(WORKER_THREAD_POOL_SIZE);
        const results = await Promise.all(sizingTasks.map(({ task }) => chartPool.render(task)));
        sizingTasks.forEach(({ directory }, index) => {
            directChartLengths.set(directory, results[index].contentLength);
        });
    } finally {
        await chartPool.destroy();
    }

    await scanDirectoryTree(
        root,
        async directory => directChartLengths.get(directory) ?? 0,
        options.thresholds ?? DIRECTORY_CHAR_THRESHOLDS
    );

    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
        registryPath,
        `${JSON.stringify(toDirectoryTreeRegistry(root), null, 2)}\n`,
        'utf-8'
    );

    return root;
}

/** Debug entry point. Always destroys the parser pool so the process can exit. */
export async function buildDirectoryTreeRegistryForDebug(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<DirectoryTreeNode> {
    try {
        return await buildDirectoryTreeRegistry(options);
    } finally {
        await destroyPool();
    }
}
