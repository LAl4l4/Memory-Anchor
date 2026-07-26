import * as fs from 'node:fs';
import * as path from 'node:path';
import { destroyPool } from '../chartBuildHelper/ASTParser.js';
import {
    buildChartContent,
    ChartParseCache,
    primeChartParseCache,
} from '../chartBuildHelper/chartContentBuilder.js';
import {
    listParseableProjectFiles,
    listProjectFiles,
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
    const dependencyFiles = listParseableProjectFiles(projectRoot);
    const root = createDirectoryTree(dirGroups.keys());
    const parseCache = options.parseCache ?? new Map();

    // One wide batch gives the pool useful parallel work and prevents reparsing
    // the same files once per registry/chart phase.
    await primeChartParseCache(dirGroups, projectRoot, parseCache);

    await scanDirectoryTree(
        root,
        async (directory) => {
            const files = dirGroups.get(directory);
            if (!files || files.length === 0) return 0;

            const directoryGroup = new Map<string, string[]>([[directory, files]]);
            return (await buildChartContent(
                directoryGroup,
                projectRoot,
                parseCache,
                'PROJECT CHART',
                dependencyFiles
            )).length;
        },
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
