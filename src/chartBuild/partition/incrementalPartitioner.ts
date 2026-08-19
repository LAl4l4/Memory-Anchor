import * as fs from 'node:fs';
import * as path from 'node:path';
import { batchParseFiles } from '../parse/ASTParser.js';
import { getChartFileNodes, renderChartContent } from '../render/chartContentBuilder.js';
import {
    PARTITIONED_CHART_DIRECTORY_NAME,
    writeChartSet,
} from '../render/runRender.js';
import {
    createGlobalDependencyRegistry,
    DEPENDENCY_GRAPH_FILE_NAME,
    loadPersistentDependencyGraph,
    persistDependencyGraph,
    updatePersistentDependencyGraph,
} from '../reverse/persistentDependencyGraph.js';
import type {
    FileNode,
    PersistentDependencyGraph,
} from '../shared/CBHTypes.js';
import {
    isCodeFile,
    isIgnored,
    listProjectFiles,
    resolveWorkspacePaths,
} from '../shared/utils.js';
import { appendDebugLog, formatError } from '../../utils/logger.js';
import {
    DIRECTORY_CHAR_THRESHOLDS,
    DirectoryCharThresholds,
    DirectoryTreeNode,
    DirectoryTreeRegistryNode,
    ensureDirectoryTreeNode,
    findDirectoryTreeNode,
    fromDirectoryTreeRegistry,
    getDirectDirectoryChars,
    pruneEmptyDirectoryTreeNodes,
    rebuildChartTree,
    toDirectoryTreeRegistry,
    validateDirectoryThresholds,
} from './directoryTree.js';
import {
    captureChartTopology,
    hasChartTopologyChanged,
    rebuildChangedPartitionCharts,
    type ChartTopologySnapshot,
    type TopologyRebuildResult,
} from './partitionedChartBuilder.js';

export interface IncrementalPartitionOptions {
    projectRoot?: string;
    thresholds?: DirectoryCharThresholds;
}

function normalizeRelativePath(file: string): string {
    return file.split(/[\\/]/).join('/').replace(/^\.\//, '');
}

/** Collapse file-level change batches before any directory-scoped I/O. */
export function getUniqueChangedDirectories(relativeFiles: readonly string[]): string[] {
    return [...new Set(
        relativeFiles.map(relativeFile =>
            path.posix.dirname(normalizeRelativePath(relativeFile))
        )
    )];
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
 * Apply one pre-rendered direct-chart delta up the physical directory chain.
 * Split state changes here, but virtual chart edges are rebuilt only after the
 * complete change batch has been applied.
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
            if (!current.isSplit && current.thisDirectoryChars > thresholds.splitAt) {
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

interface IncrementalWorkspace {
    projectRoot: string;
    registryPath: string;
    indexPath: string;
    dependencyGraphPath: string;
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
        dependencyGraphPath: path.join(anchorDirectory, DEPENDENCY_GRAPH_FILE_NAME),
    };
}

function loadDirectoryTree(workspace: IncrementalWorkspace): DirectoryTreeNode | null {
    if (!fs.existsSync(workspace.registryPath) || !fs.existsSync(workspace.indexPath)) {
        const missing = [workspace.registryPath, workspace.indexPath]
            .filter(filePath => !fs.existsSync(filePath))
            .map(filePath => path.basename(filePath));
        appendDebugLog(
            'warn',
            `Incremental topology unavailable: missing ${missing.join(', ')}.`
        );
        return null;
    }
    try {
        const registry = JSON.parse(
            fs.readFileSync(workspace.registryPath, 'utf-8')
        ) as DirectoryTreeRegistryNode;
        return fromDirectoryTreeRegistry(registry);
    } catch (error) {
        appendDebugLog(
            'warn',
            `Incremental topology is invalid at ${workspace.registryPath}: ${formatError(error)}`
        );
        return null;
    }
}

function listDirectProjectFiles(projectRoot: string, directory: string): string[] {
    const sourceDirectory = directory === '.'
        ? projectRoot
        : path.join(projectRoot, directory);
    try {
        if (!fs.statSync(sourceDirectory).isDirectory()) return [];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }

    return [...listProjectFiles(sourceDirectory, false).values()]
        .flat()
        .map(file => directory === '.'
            ? normalizeRelativePath(file)
            : path.posix.join(directory, normalizeRelativePath(file))
        )
        .sort((left, right) => left.localeCompare(right));
}

interface IncrementalParseBatch {
    directFilesByDirectory: Map<string, string[]>;
    parseCache: Map<string, FileNode>;
    changedNodes: FileNode[];
}

async function parseRelativeFiles(
    relativeFiles: Iterable<string>,
    projectRoot: string,
    parseCache: Map<string, FileNode>
): Promise<void> {
    const filesToParse = [...new Set(relativeFiles)]
        .filter(relativeFile => !parseCache.has(path.resolve(projectRoot, relativeFile)))
        .sort((left, right) => left.localeCompare(right));
    if (filesToParse.length === 0) return;

    const parsedFiles = await batchParseFiles(filesToParse.map(relativePath => ({
        absolutePath: path.join(projectRoot, relativePath),
        relativePath,
    })));
    parsedFiles.forEach((fileNode, index) => {
        parseCache.set(path.resolve(projectRoot, filesToParse[index]), fileNode);
    });
}

/**
 * Incremental parse stage. It parses changed files plus one direct-file view
 * per changed physical directory, allowing the following pre-render stage to
 * measure the exact same direct chart unit used by full partition sizing.
 */
async function parseIncrementalBatch(
    relativeFiles: readonly string[],
    projectRoot: string
): Promise<IncrementalParseBatch> {
    const directFilesByDirectory = new Map<string, string[]>();
    const parsePaths = new Set<string>();

    for (const directory of getUniqueChangedDirectories(relativeFiles)) {
        const files = listDirectProjectFiles(projectRoot, directory);
        directFilesByDirectory.set(directory, files);
        files.forEach(file => parsePaths.add(file));
    }

    // A changed file normally appears in its direct listing. Keep this extra
    // check for races such as a just-created symlink or a directory rename.
    for (const relativeFile of relativeFiles) {
        const absolutePath = path.join(projectRoot, relativeFile);
        try {
            if (fs.statSync(absolutePath).isFile()) parsePaths.add(relativeFile);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    const parseCache = new Map<string, FileNode>();
    await parseRelativeFiles(parsePaths, projectRoot, parseCache);

    const changedNodes = relativeFiles.flatMap(relativeFile => {
        const node = parseCache.get(path.resolve(projectRoot, relativeFile));
        return node ? [node] : [];
    });
    return { directFilesByDirectory, parseCache, changedNodes };
}

/**
 * Add direct physical directories whose graph annotations changed after the
 * initial changed-file parse. Their confirmed sizes must participate in the
 * same topology update as the files that triggered the graph change.
 */
async function addPreRenderDirectories(
    batch: IncrementalParseBatch,
    directories: Iterable<string>,
    projectRoot: string
): Promise<void> {
    const parsePaths = new Set<string>();
    for (const directory of directories) {
        if (batch.directFilesByDirectory.has(directory)) continue;
        const files = listDirectProjectFiles(projectRoot, directory);
        batch.directFilesByDirectory.set(directory, files);
        files.forEach(file => parsePaths.add(file));
    }
    await parseRelativeFiles(parsePaths, projectRoot, batch.parseCache);
}

function updateDependencyPaths(
    graph: PersistentDependencyGraph,
    relativeFiles: readonly string[],
    projectRoot: string
): ReadonlySet<string> {
    const dependencyPaths = new Set(graph.files);
    for (const relativeFile of relativeFiles) {
        const absolutePath = path.join(projectRoot, relativeFile);
        try {
            if (fs.statSync(absolutePath).isFile() && isCodeFile(relativeFile)) {
                dependencyPaths.add(relativeFile);
            } else {
                dependencyPaths.delete(relativeFile);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                dependencyPaths.delete(relativeFile);
                continue;
            }
            throw error;
        }
    }
    return dependencyPaths;
}

interface DirectDirectoryPreview {
    directory: string;
    files: string[];
    chars: number;
}

interface TopologyPreviewUpdate {
    changed: boolean;
    /** Direct physical directories whose confirmed chart unit changed. */
    changedDirectories: string[];
}

/** Pre-render stage: measure direct chart content without changing output files. */
function preRenderDirectories(
    batch: IncrementalParseBatch,
    projectRoot: string,
    dependencyPaths: ReadonlySet<string>,
    dependencyGraph: PersistentDependencyGraph
): DirectDirectoryPreview[] {
    const registry = createGlobalDependencyRegistry(dependencyGraph);
    const previews: DirectDirectoryPreview[] = [];

    for (const [directory, files] of batch.directFilesByDirectory) {
        if (files.length === 0) {
            previews.push({ directory, files, chars: 0 });
            continue;
        }
        const directFiles = new Map<string, string[]>([[directory, files]]);
        const fileNodes = getChartFileNodes(directFiles, projectRoot, batch.parseCache);
        const content = renderChartContent(
            directFiles,
            fileNodes,
            'PROJECT CHART',
            dependencyPaths,
            registry,
            '.'
        );
        previews.push({ directory, files, chars: content.length });
    }
    return previews;
}

/** Apply the confirmed direct-chart sizes, then rebuild virtual ownership once. */
function updateTopologyFromPreviews(
    root: DirectoryTreeNode,
    previews: readonly DirectDirectoryPreview[],
    thresholds: DirectoryCharThresholds
): TopologyPreviewUpdate {
    let changed = false;
    const changedDirectories = new Set<string>();
    for (const preview of previews) {
        let node = findDirectoryTreeNode(root, preview.directory);
        if (!node && preview.files.length === 0) continue;
        node ??= ensureDirectoryTreeNode(root, preview.directory);

        const previousDirectChars = getDirectDirectoryChars(node);
        const hasDirectFiles = preview.files.length > 0;
        const delta = preview.chars - previousDirectChars;
        if (delta !== 0 || node.hasDirectFiles !== hasDirectFiles) {
            changed = true;
            changedDirectories.add(preview.directory);
        }

        node.hasDirectFiles = hasDirectFiles;
        if (delta !== 0) {
            const splitBoundary = applyDirectoryCharsDelta(node, delta, thresholds);
            if (splitBoundary) changedDirectories.add(splitBoundary.directory);
        }
    }

    if (changed) {
        pruneEmptyDirectoryTreeNodes(root);
        rebuildChartTree(root);
    }
    return {
        changed,
        changedDirectories: [...changedDirectories],
    };
}

function ownerDirectoriesForFiles(
    root: DirectoryTreeNode,
    relativeFiles: readonly string[]
): Set<string> {
    const directories = new Set<string>();
    for (const relativeFile of relativeFiles) {
        const partition = findPartitionForFile(root, relativeFile);
        if (partition) directories.add(partition.directory);
    }
    return directories;
}

function dirtyTargetOwnerDirectories(
    root: DirectoryTreeNode,
    dirtyTargetKeys: readonly string[],
    dependencyGraph: PersistentDependencyGraph
): Set<string> {
    const directories = new Set<string>();
    for (const targetKey of dirtyTargetKeys) {
        if (dependencyGraph.targetSymbolOffsets[targetKey] === undefined) continue;
        const targetPath = targetKeyPath(targetKey);
        if (!targetPath) continue;
        const partition = findPartitionForFile(root, targetPath);
        if (partition) directories.add(partition.directory);
    }
    return directories;
}

/** Find unchanged importer charts whose resolved `->` file edge may change. */
function dirtyFileImporterOwnerDirectories(
    root: DirectoryTreeNode,
    importerPaths: readonly string[]
): Set<string> {
    const directories = new Set<string>();
    for (const importerPath of importerPaths) {
        const partition = findPartitionForFile(root, importerPath);
        if (partition) directories.add(partition.directory);
    }
    return directories;
}

function targetKeyPath(targetKey: string): string | null {
    const delimiter = targetKey.indexOf('\0');
    return delimiter < 0 ? null : targetKey.slice(0, delimiter);
}

/**
 * Direct directories that need re-sizing after graph reconciliation. A
 * reverse-caller annotation changes the target's direct chart content; a
 * resolved/unresolved file edge changes the importer's direct chart content.
 */
function getPreRenderDirectories(
    relativeFiles: readonly string[],
    dirtyTargetKeys: readonly string[],
    dirtyFileImporterPaths: readonly string[],
    dependencyGraph: PersistentDependencyGraph
): string[] {
    const directories = new Set(getUniqueChangedDirectories(relativeFiles));
    for (const targetKey of dirtyTargetKeys) {
        if (dependencyGraph.targetSymbolOffsets[targetKey] === undefined) continue;
        const targetPath = targetKeyPath(targetKey);
        if (targetPath) directories.add(path.posix.dirname(targetPath));
    }
    for (const importerPath of dirtyFileImporterPaths) {
        directories.add(path.posix.dirname(normalizeRelativePath(importerPath)));
    }
    return [...directories].sort((left, right) => left.localeCompare(right));
}

function toDependencyFiles(
    projectRoot: string,
    dependencyPaths: ReadonlySet<string>
): string[] {
    return [...dependencyPaths].map(relativePath => path.join(projectRoot, relativePath));
}

interface IncrementalRenderResult {
    renderedDirectories: string[];
    removedDirectories: string[];
}

async function renderFinalCharts(
    previousTopology: ChartTopologySnapshot,
    nextTopology: ChartTopologySnapshot,
    topologyChanged: boolean,
    renderDirectories: readonly string[],
    workspace: IncrementalWorkspace,
    dependencyPaths: ReadonlySet<string>,
    dependencyGraph: PersistentDependencyGraph
): Promise<IncrementalRenderResult> {
    const dependencyFiles = toDependencyFiles(workspace.projectRoot, dependencyPaths);
    const globalDependencyRegistry = createGlobalDependencyRegistry(dependencyGraph);
    if (topologyChanged) {
        const result: TopologyRebuildResult = await rebuildChangedPartitionCharts(
            previousTopology,
            nextTopology,
            {
                projectRoot: workspace.projectRoot,
                additionalDirectories: renderDirectories,
                dependencyFiles,
                globalDependencyRegistry,
            }
        );
        return result;
    }

    if (renderDirectories.length === 0) {
        return { renderedDirectories: [], removedDirectories: [] };
    }
    await writeChartSet(
        renderDirectories,
        workspace.projectRoot,
        path.join(workspace.projectRoot, '.memoryanchor', PARTITIONED_CHART_DIRECTORY_NAME),
        {
            shallowDirectories: nextTopology.shallowDirectories,
            chartChildren: nextTopology.chartChildren,
            rootDirectories: nextTopology.rootDirectories,
            dependencyFiles,
            globalDependencyRegistry,
        }
    );
    return { renderedDirectories: [...renderDirectories], removedDirectories: [] };
}

/**
 * Incremental pipeline:
 *   parse changed/direct files → reconcile graph → pre-render direct sizes
 *   → update topology → reparse and render affected charts.
 *
 * Returning false intentionally asks the public adapter to perform a full
 * build when durable state is missing or invalid.
 */
export async function updatePartitionedChartsIncrementally(
    changedFiles: string[],
    options: IncrementalPartitionOptions = {}
): Promise<boolean> {
    const workspace = resolveIncrementalWorkspace(options);
    const root = loadDirectoryTree(workspace);
    if (!root) return false;

    const files = normalizeChangedFiles(changedFiles);
    if (files.length === 0) {
        appendDebugLog('debug', 'Incremental partition pipeline skipped: every changed path is ignored.');
        return true;
    }

    const dependencyGraph = loadPersistentDependencyGraph(workspace.dependencyGraphPath);
    if (!dependencyGraph) {
        appendDebugLog(
            'warn',
            `Incremental dependency graph unavailable: ${workspace.dependencyGraphPath}`
        );
        return false;
    }

    appendDebugLog(
        'debug',
        `Incremental partition pipeline started for ${files.length} file(s) across ${getUniqueChangedDirectories(files).length} director${getUniqueChangedDirectories(files).length === 1 ? 'y' : 'ies'}.`
    );

    const previousRoot = fromDirectoryTreeRegistry(toDirectoryTreeRegistry(root));
    const previousTopology = captureChartTopology(root);

    const batch = await parseIncrementalBatch(files, workspace.projectRoot);
    const dependencyPaths = updateDependencyPaths(
        dependencyGraph,
        files,
        workspace.projectRoot
    );
    const graphUpdate = updatePersistentDependencyGraph(
        dependencyGraph,
        batch.changedNodes,
        files,
        dependencyPaths
    );
    await addPreRenderDirectories(
        batch,
        getPreRenderDirectories(
            files,
            graphUpdate.dirtyTargetKeys,
            graphUpdate.dirtyFileImporterPaths,
            dependencyGraph
        ),
        workspace.projectRoot
    );

    const previews = preRenderDirectories(
        batch,
        workspace.projectRoot,
        dependencyPaths,
        dependencyGraph
    );
    const topologyUpdate = updateTopologyFromPreviews(
        root,
        previews,
        workspace.thresholds
    );
    const nextTopology = topologyUpdate.changed
        ? captureChartTopology(root)
        : previousTopology;
    const topologyChanged = topologyUpdate.changed && hasChartTopologyChanged(
        previousTopology,
        nextTopology
    );

    const requestedDirectories = new Set<string>([
        ...ownerDirectoriesForFiles(previousRoot, files),
        ...ownerDirectoriesForFiles(root, files),
        ...dirtyTargetOwnerDirectories(root, graphUpdate.dirtyTargetKeys, dependencyGraph),
        ...dirtyFileImporterOwnerDirectories(root, graphUpdate.dirtyFileImporterPaths),
    ]);
    const renderDirectories = nextTopology.directories.filter(directory =>
        requestedDirectories.has(directory)
    );

    const renderResult = await renderFinalCharts(
        previousTopology,
        nextTopology,
        topologyChanged,
        renderDirectories,
        workspace,
        dependencyPaths,
        dependencyGraph
    );

    if (graphUpdate.changed) {
        persistDependencyGraph(workspace.dependencyGraphPath, dependencyGraph);
    }
    if (topologyUpdate.changed) {
        persistDirectoryTree(workspace.registryPath, root);
    }
    appendDebugLog(
        'debug',
        `Incremental partition pipeline completed: rendered ${renderResult.renderedDirectories.length} chart(s), ` +
        `removed ${renderResult.removedDirectories.length} obsolete chart(s); topology changed: ${topologyChanged}.`
    );
    return true;
}
