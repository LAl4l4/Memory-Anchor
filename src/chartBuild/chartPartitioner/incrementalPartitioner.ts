import * as fs from 'node:fs';
import * as path from 'node:path';
import { updatePartitionChartContent } from '../chartBuildHelper/partitionChartIncrementalUpdater.js';
import { isIgnored, resolveWorkspacePaths } from '../chartBuildHelper/utils.js';
import {
    DIRECTORY_CHAR_THRESHOLDS,
    DirectoryCharThresholds,
    DirectoryTreeNode,
    DirectoryTreeRegistryNode,
    fromDirectoryTreeRegistry,
    toDirectoryTreeRegistry,
    validateDirectoryThresholds,
} from './directoryTree.js';
import { rebuildPartitionBoundary } from './partitionedChartBuilder.js';

export interface IncrementalPartitionOptions {
    projectRoot?: string;
    thresholds?: DirectoryCharThresholds;
}

function normalizeRelativePath(file: string): string {
    return file.split(path.sep).join('/').replace(/^\.\//, '');
}

/** Whether a prior boundary rebuild already refreshed this file from disk. */
export function isFileCoveredByRebuiltDirectory(
    relativeFile: string,
    rebuiltDirectories: ReadonlySet<string>
): boolean {
    let directory = path.posix.dirname(normalizeRelativePath(relativeFile));

    while (true) {
        if (rebuiltDirectories.has(directory)) return true;
        if (directory === '.') return false;
        directory = path.posix.dirname(directory);
    }
}

/** Find the first non-split directory along a changed file's directory path. */
export function findPartitionForFile(
    root: DirectoryTreeNode,
    relativeFile: string
): DirectoryTreeNode | null {
    if (!root.isSplit) return root;

    const directory = path.posix.dirname(normalizeRelativePath(relativeFile));
    if (directory === '.') return null;

    let current = root;
    let currentPath = '';
    for (const segment of directory.split('/')) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const child = current.children.find(node => node.directory === currentPath);
        if (!child) return null;
        current = child;
        if (!current.isSplit) return current;
    }

    return null;
}

/**
 * Apply one chart-size delta up the parent chain. Growth stops changing
 * topology after the first split. Shrinkage keeps merging eligible ancestors
 * through the root and returns the highest changed boundary, whose rebuild
 * subsumes every merge below it. All ancestors still get their totals updated.
 */
export function applyDirectoryCharsDelta(
    start: DirectoryTreeNode,
    delta: number,
    thresholds: DirectoryCharThresholds = DIRECTORY_CHAR_THRESHOLDS
): DirectoryTreeNode | null {
    validateDirectoryThresholds(thresholds);
    let boundaryChange: DirectoryTreeNode | null = null;
    let current: DirectoryTreeNode | null = start;

    while (current) {
        current.thisDirectoryChars = Math.max(0, current.thisDirectoryChars + delta);

        if (delta > 0) {
            if (
                !boundaryChange &&
                !current.isSplit &&
                current.thisDirectoryChars > thresholds.splitAt
            ) {
                current.isSplit = true;
                boundaryChange = current;
            }
        } else if (
            delta < 0 &&
            current.isSplit &&
            current.thisDirectoryChars < thresholds.mergeAt
        ) {
            current.isSplit = false;
            boundaryChange = current;
        }

        current = current.parent;
    }

    return boundaryChange;
}

function persistDirectoryTree(registryPath: string, root: DirectoryTreeNode): void {
    fs.writeFileSync(
        registryPath,
        `${JSON.stringify(toDirectoryTreeRegistry(root), null, 2)}\n`,
        'utf-8'
    );
}

/**
 * Update partition charts and the directory registry in O(depth × changed)
 * tree work. Returns false when topology is missing and a full build is needed.
 */
export async function updatePartitionedChartsIncrementally(
    changedFiles: string[],
    options: IncrementalPartitionOptions = {}
): Promise<boolean> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const registryPath = path.join(projectRoot, '.memoryanchor', 'dirTree.json');
    const indexPath = path.join(projectRoot, '.memoryanchor', 'index.md');
    const thresholds = options.thresholds ?? DIRECTORY_CHAR_THRESHOLDS;
    validateDirectoryThresholds(thresholds);

    if (!fs.existsSync(registryPath) || !fs.existsSync(indexPath)) return false;

    const registry = JSON.parse(
        fs.readFileSync(registryPath, 'utf-8')
    ) as DirectoryTreeRegistryNode;
    const root = fromDirectoryTreeRegistry(registry);
    const rebuiltDirectories = new Set<string>();

    for (const rawFile of changedFiles) {
        const relativeFile = normalizeRelativePath(rawFile);
        if (isIgnored(relativeFile)) continue;
        if (isFileCoveredByRebuiltDirectory(relativeFile, rebuiltDirectories)) continue;

        const partition = findPartitionForFile(root, relativeFile);
        if (!partition) return false;

        const partitionRoot = partition.directory === '.'
            ? projectRoot
            : path.join(projectRoot, partition.directory);
        const localFile = normalizeRelativePath(
            path.relative(partitionRoot, path.join(projectRoot, relativeFile))
        );
        if (localFile === '..' || localFile.startsWith('../')) return false;

        const chartDirectory = partition.directory === '.'
            ? path.join(projectRoot, '.memoryanchor', 'chart')
            : path.join(projectRoot, '.memoryanchor', 'chart', partition.directory);
        const chartPath = path.join(chartDirectory, 'chart.md');
        if (!fs.existsSync(chartPath)) return false;

        const result = await updatePartitionChartContent(
            chartPath,
            partitionRoot,
            [localFile]
        );
        if (!result.changed) continue;

        const boundaryChange = applyDirectoryCharsDelta(
            partition,
            result.currentChars - result.previousChars,
            thresholds
        );
        if (boundaryChange) {
            await rebuildPartitionBoundary(root, boundaryChange, { projectRoot });
            rebuiltDirectories.add(boundaryChange.directory);
        }

        persistDirectoryTree(registryPath, root);
    }

    return true;
}
