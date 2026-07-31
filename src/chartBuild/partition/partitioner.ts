import type { ChartParseCache, GlobalDependencyRegistry } from '../shared/CBHTypes.js';
import {
    DIRECTORY_CHAR_THRESHOLDS,
    DirectoryCharThresholds,
    DirectoryTreeNode,
    getDeepestFirstNodes,
    isChartOwner,
    rebuildChartTree,
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
    /** Reuse a build-wide reverse registry when the caller already has one. */
    globalDependencyRegistry?: GlobalDependencyRegistry;
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

/** Immediate virtual-chart children keyed by chart directory. */
export function getChartChildren(root: DirectoryTreeNode): Map<string, string[]> {
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
