import * as fs from 'node:fs';
import * as path from 'node:path';
import { getChartFileNodes } from '../render/chartContentBuilder.js';
import { ChartWorkerPool } from '../render/chartPool.js';
import { WORKER_THREAD_POOL_SIZE } from '../parse/ASTParser.js';
import {
    DIRECTORY_TREE_REGISTRY_NAME,
    getChartChildren,
    getDirectoriesToScan,
    getRootChartDirectories,
    getShallowPartitionDirectories,
    scanDirectoryTree,
} from './partitioner.js';
import {
    createDirectoryTree,
    DIRECTORY_CHAR_THRESHOLDS,
    DirectoryCharThresholds,
    DirectoryTreeNode,
    toDirectoryTreeRegistry,
} from './directoryTree.js';
import type {
    ChartParseCache,
    ChartRenderTask,
    GlobalDependencyRegistry,
} from '../shared/CBHTypes.js';
import { logToUser } from '../shared/utils.js';

export interface PartitionStageOptions {
    projectRoot: string;
    dirGroups: Map<string, string[]>;
    parseCache: ChartParseCache;
    dependencyFiles: string[];
    dependencyPaths: ReadonlySet<string>;
    globalDependencyRegistry: GlobalDependencyRegistry;
    registryPath?: string;
    thresholds?: DirectoryCharThresholds;
}

export interface PartitionStageResult {
    root: DirectoryTreeNode;
    directories: string[];
    shallowDirectories: Set<string>;
    chartChildren: Map<string, string[]>;
    rootDirectories: string[];
}

/**
 * Stage 3: measure each directory's rendered chart length, roll sizes up the
 * physical tree, mark split boundaries, persist the directory-tree registry,
 * and derive the serializable chart topology consumed by the render stage.
 */
export async function partition(
    options: PartitionStageOptions
): Promise<PartitionStageResult> {
    const registryPath = path.resolve(
        options.registryPath
            ?? path.join(options.projectRoot, '.memoryanchor', DIRECTORY_TREE_REGISTRY_NAME)
    );
    const root = createDirectoryTree(options.dirGroups.keys());

    const sizingTasks: { directory: string; task: ChartRenderTask }[] = [];
    for (const [directory, files] of options.dirGroups) {
        if (files.length === 0) continue;
        const directoryGroup = new Map<string, string[]>([[directory, files]]);
        sizingTasks.push({
            directory,
            task: {
                sourceDirectory: options.projectRoot,
                dirGroups: [...directoryGroup.entries()],
                fileNodes: getChartFileNodes(directoryGroup, options.projectRoot, options.parseCache),
                chartHeading: 'PROJECT CHART',
                childChartsSection: '',
                chartDirectory: '.',
                writeOutput: false,
            },
        });
    }

    const directChartLengths = new Map<string, number>();
    logToUser(`Sizing ${sizingTasks.length} directories for chart partitions...`, '36');
    const chartPool = new ChartWorkerPool(
        options.dependencyFiles,
        options.dependencyPaths,
        options.globalDependencyRegistry
    );
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

    return {
        root,
        directories: getDirectoriesToScan(root),
        shallowDirectories: getShallowPartitionDirectories(root),
        chartChildren: getChartChildren(root),
        rootDirectories: getRootChartDirectories(root),
    };
}
