import * as fs from 'node:fs';
import * as path from 'node:path';
import { updatePartitionChartContent } from '../render/partitionChartIncrementalUpdater.js';
import {
    hasDirectProjectFiles,
    isIgnored,
    resolveWorkspacePaths,
} from '../shared/utils.js';
import {
    DIRECTORY_CHAR_THRESHOLDS,
    DirectoryCharThresholds,
    DirectoryTreeNode,
    DirectoryTreeRegistryNode,
    fromDirectoryTreeRegistry,
    toDirectoryTreeRegistry,
    validateDirectoryThresholds,
} from './directoryTree.js';
import {
    buildPartitionedCharts,
    captureChartTopology,
    rebuildPartitionBoundary,
} from './partitionedChartBuilder.js';

export interface IncrementalPartitionOptions {
    projectRoot?: string;
    thresholds?: DirectoryCharThresholds;
}

function normalizeRelativePath(file: string): string {
    return file.split(path.sep).join('/').replace(/^\.\//, '');
}

/** Collapse file-level change batches before any directory-scoped I/O. */
export function getUniqueChangedDirectories(relativeFiles: readonly string[]): string[] {
    return [...new Set(
        relativeFiles.map(relativeFile =>
            path.posix.dirname(normalizeRelativePath(relativeFile))
        )
    )];
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

function findDirectoryNode(
    root: DirectoryTreeNode,
    directory: string
): DirectoryTreeNode | null {
    if (directory === '.') return root;

    let current = root;
    let currentPath = '';
    for (const segment of directory.split('/')) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const child = current.children.find(node => node.directory === currentPath);
        if (!child) return null;
        current = child;
    }
    return current;
}

/** Find the threshold-frontier chart or shallow split ancestor owning a file. */
export function findPartitionForFile(
    root: DirectoryTreeNode,
    relativeFile: string
): DirectoryTreeNode | null {
    if (!root.isSplit) return root;

    const directory = path.posix.dirname(normalizeRelativePath(relativeFile));
    if (directory === '.') return root.hasDirectFiles ? root : null;

    let current = root;
    let currentPath = '';
    for (const segment of directory.split('/')) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const child = current.children.find(node => node.directory === currentPath);
        if (!child) return null;
        current = child;
        if (!current.isSplit) return current;
    }

    return current.hasDirectFiles ? current : null;
}

/**
 * Apply one chart-size delta up the physical directory chain. Every crossing
 * node updates its split state so a later topology rebuild sees consistent
 * descendant and ancestor thresholds. The highest changed node is returned.
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

function normalizeChangedFiles(changedFiles: readonly string[]): string[] {
    return [...new Set(
        changedFiles
            .map(normalizeRelativePath)
            .filter(relativeFile => !isIgnored(relativeFile))
    )];
}

function hasDirectOwnershipChange(
    root: DirectoryTreeNode,
    relativeFiles: readonly string[],
    projectRoot: string
): boolean {
    for (const directory of getUniqueChangedDirectories(relativeFiles)) {
        const node = findDirectoryNode(root, directory);
        const sourceDirectory = directory === '.'
            ? projectRoot
            : path.join(projectRoot, directory);
        const hasDirectFilesOnDisk = hasDirectProjectFiles(sourceDirectory);
        if (
            (node === null && hasDirectFilesOnDisk) ||
            (node !== null && node.hasDirectFiles !== hasDirectFilesOnDisk)
        ) {
            return true;
        }
    }
    return false;
}

interface PartitionUpdatePaths {
    partitionRoot: string;
    chartPath: string;
    localFile: string;
}

function resolvePartitionUpdatePaths(
    partition: DirectoryTreeNode,
    relativeFile: string,
    projectRoot: string
): PartitionUpdatePaths | null {
    const partitionRoot = partition.directory === '.'
        ? projectRoot
        : path.join(projectRoot, partition.directory);
    const localFile = normalizeRelativePath(
        path.relative(partitionRoot, path.join(projectRoot, relativeFile))
    );
    if (localFile === '..' || localFile.startsWith('../')) return null;

    const chartDirectory = partition.directory === '.'
        ? path.join(projectRoot, '.memoryanchor', 'chart')
        : path.join(projectRoot, '.memoryanchor', 'chart', partition.directory);
    return {
        partitionRoot,
        localFile,
        chartPath: path.join(chartDirectory, 'chart.md'),
    };
}

interface IncrementalFileUpdate {
    valid: boolean;
    changed: boolean;
    boundaryChange: DirectoryTreeNode | null;
}

async function updateIncrementalFile(
    root: DirectoryTreeNode,
    relativeFile: string,
    projectRoot: string,
    thresholds: DirectoryCharThresholds
): Promise<IncrementalFileUpdate> {
    const partition = findPartitionForFile(root, relativeFile);
    if (!partition) return { valid: true, changed: false, boundaryChange: null };

    const changedDirectory = findDirectoryNode(root, path.posix.dirname(relativeFile));
    const paths = resolvePartitionUpdatePaths(partition, relativeFile, projectRoot);
    if (!changedDirectory || !paths || !fs.existsSync(paths.chartPath)) {
        return { valid: false, changed: false, boundaryChange: null };
    }

    const result = await updatePartitionChartContent(
        paths.chartPath,
        paths.partitionRoot,
        [paths.localFile]
    );
    if (!result.changed) return { valid: true, changed: false, boundaryChange: null };

    return {
        valid: true,
        changed: true,
        boundaryChange: applyDirectoryCharsDelta(
            changedDirectory,
            result.currentChars - result.previousChars,
            thresholds
        ),
    };
}

interface IncrementalWorkspace {
    projectRoot: string;
    registryPath: string;
    indexPath: string;
    thresholds: DirectoryCharThresholds;
}

function resolveIncrementalWorkspace(
    options: IncrementalPartitionOptions
): IncrementalWorkspace {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const anchorDirectory = path.join(projectRoot, '.memoryanchor');
    const thresholds = options.thresholds ?? DIRECTORY_CHAR_THRESHOLDS;
    validateDirectoryThresholds(thresholds);
    return {
        projectRoot,
        thresholds,
        registryPath: path.join(anchorDirectory, 'dirTree.json'),
        indexPath: path.join(anchorDirectory, 'index.md'),
    };
}

function loadDirectoryTree(workspace: IncrementalWorkspace): DirectoryTreeNode | null {
    if (
        !fs.existsSync(workspace.registryPath) ||
        !fs.existsSync(workspace.indexPath)
    ) {
        return null;
    }
    const registry = JSON.parse(
        fs.readFileSync(workspace.registryPath, 'utf-8')
    ) as DirectoryTreeRegistryNode;
    return fromDirectoryTreeRegistry(registry);
}

async function updateIncrementalFileBatch(
    root: DirectoryTreeNode,
    files: readonly string[],
    workspace: IncrementalWorkspace
): Promise<boolean> {
    const previousTopology = captureChartTopology(root);
    let registryChanged = false;
    for (const relativeFile of files) {
        const update = await updateIncrementalFile(
            root,
            relativeFile,
            workspace.projectRoot,
            workspace.thresholds
        );
        if (!update.valid) return false;
        if (!update.changed) continue;

        registryChanged = true;
        if (update.boundaryChange) {
            await rebuildPartitionBoundary(root, update.boundaryChange, {
                projectRoot: workspace.projectRoot,
                previousTopology,
            });
            persistDirectoryTree(workspace.registryPath, root);
            return true;
        }
    }

    if (registryChanged) persistDirectoryTree(workspace.registryPath, root);
    return true;
}

/**
 * Update virtual charts and the directory registry in O(depth × changed) tree
 * work. Ownership changes rebuild immediately; false requests caller fallback
 * only when the base registry/index or an expected chart is missing.
 */
export async function updatePartitionedChartsIncrementally(
    changedFiles: string[],
    options: IncrementalPartitionOptions = {}
): Promise<boolean> {
    const workspace = resolveIncrementalWorkspace(options);
    const root = loadDirectoryTree(workspace);
    if (!root) return false;
    const files = normalizeChangedFiles(changedFiles);

    // Adding the first direct file or deleting the last one changes the virtual
    // chart tree (and possibly its root layer). Rebuild once from disk before
    // touching any individual chart so parent/child links stay atomic.
    if (hasDirectOwnershipChange(root, files, workspace.projectRoot)) {
        await buildPartitionedCharts({
            projectRoot: workspace.projectRoot,
            thresholds: workspace.thresholds,
        });
        return true;
    }
    return updateIncrementalFileBatch(root, files, workspace);
}
