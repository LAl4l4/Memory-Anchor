export interface DirectoryCharThresholds {
    splitAt: number;
    mergeAt: number;
}

export const DIRECTORY_CHAR_THRESHOLDS: Readonly<DirectoryCharThresholds> = {
    splitAt: 18000,
    mergeAt: 14000,
};

const CHART_TOPOLOGY_VERSION = 2;

/** Runtime node. `parent` is retained for bottom-up traversal. */
export interface DirectoryTreeNode {
    directory: string;
    parent: DirectoryTreeNode | null;
    children: DirectoryTreeNode[];
    /** Whether this directory, rather than only one of its descendants, owns files. */
    hasDirectFiles: boolean;
    /** Nearest ancestor that owns a chart; null for virtual chart roots. */
    chartParent: DirectoryTreeNode | null;
    /** Nearest descendant chart owners, with file-less wrapper directories skipped. */
    chartChildren: DirectoryTreeNode[];
    thisDirectoryChars: number;
    isSplit: boolean;
}

/** JSON-safe registry node; parent is stored as a directory path. */
export interface DirectoryTreeRegistryNode {
    directory: string;
    parent: string | null;
    children: DirectoryTreeRegistryNode[];
    hasDirectFiles: boolean;
    /** Persisted path of the runtime chartParent edge. */
    chartParent: string | null;
    /** Persisted paths of the runtime chartChildren edges. */
    chartChildren: string[];
    /** Invalidates persisted edges when chart-owner semantics change. */
    chartTopologyVersion: number;
    thisDirectoryChars: number;
    isSplit: boolean;
}

export function validateDirectoryThresholds(thresholds: DirectoryCharThresholds): void {
    if (
        thresholds.mergeAt < 0 ||
        thresholds.splitAt <= thresholds.mergeAt
    ) {
        throw new RangeError('Directory thresholds require 0 <= mergeAt < splitAt');
    }
}

function createNode(directory: string, parent: DirectoryTreeNode | null): DirectoryTreeNode {
    return {
        directory,
        parent,
        children: [],
        hasDirectFiles: false,
        chartParent: null,
        chartChildren: [],
        thisDirectoryChars: 0,
        isSplit: false,
    };
}

function normalizeDirectory(directory: string): string {
    return directory.split('\\').join('/');
}

/** Locate a physical directory node by its workspace-relative path. */
export function findDirectoryTreeNode(
    root: DirectoryTreeNode,
    directory: string
): DirectoryTreeNode | null {
    const normalized = normalizeDirectory(directory);
    if (normalized === '.') return root;

    let current = root;
    let currentPath = '';
    for (const segment of normalized.split('/').filter(Boolean)) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const child = current.children.find(node => node.directory === currentPath);
        if (!child) return null;
        current = child;
    }
    return current;
}

/**
 * Materialize a physical directory path without changing chart ownership.
 * Incremental updates use this when a newly created file introduces a branch
 * that did not exist when the persisted registry was written.
 */
export function ensureDirectoryTreeNode(
    root: DirectoryTreeNode,
    directory: string
): DirectoryTreeNode {
    const normalized = normalizeDirectory(directory);
    if (normalized === '.') return root;

    let current = root;
    let currentPath = '';
    for (const segment of normalized.split('/').filter(Boolean)) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        let child = current.children.find(node => node.directory === currentPath);
        if (!child) {
            child = createNode(currentPath, current);
            current.children.push(child);
            current.children.sort((left, right) => left.directory.localeCompare(right.directory));
        }
        current = child;
    }
    return current;
}

/** Return the direct contribution stored in an aggregate directory total. */
export function getDirectDirectoryChars(node: DirectoryTreeNode): number {
    const childChars = node.children.reduce(
        (total, child) => total + child.thisDirectoryChars,
        0
    );
    return Math.max(0, node.thisDirectoryChars - childChars);
}

/**
 * Remove physical branches that no longer own files or descendants. Virtual
 * chart edges are rebuilt separately after the physical tree is finalized.
 */
export function pruneEmptyDirectoryTreeNodes(root: DirectoryTreeNode): void {
    const prune = (node: DirectoryTreeNode): boolean => {
        node.children = node.children.filter(child => !prune(child));
        return node.parent !== null && !node.hasDirectFiles && node.children.length === 0;
    };
    prune(root);
}

/** Build a complete directory tree, including ancestors that have no direct files. */
export function createDirectoryTree(directories: Iterable<string>): DirectoryTreeNode {
    const root = createNode('.', null);
    const nodes = new Map<string, DirectoryTreeNode>([['.', root]]);
    const sortedDirectories = [...directories]
        .map(normalizeDirectory)
        .sort((a, b) => a.localeCompare(b));

    for (const directory of sortedDirectories) {
        let current = root;
        let currentPath = '';

        if (directory !== '.') {
            for (const segment of directory.split('/').filter(Boolean)) {
                currentPath = currentPath ? `${currentPath}/${segment}` : segment;
                let child = nodes.get(currentPath);
                if (!child) {
                    child = createNode(currentPath, current);
                    current.children.push(child);
                    nodes.set(currentPath, child);
                }
                current = child;
            }
        }

        current.hasDirectFiles = true;
    }

    for (const node of nodes.values()) {
        node.children.sort((a, b) => a.directory.localeCompare(b.directory));
    }

    rebuildChartTree(root);

    return root;
}

/**
 * Build the threshold-frontier chart tree. Non-split owners cover their full
 * subtree; split wrappers are skipped unless they preserve direct files.
 */
export function rebuildChartTree(root: DirectoryTreeNode): void {
    const clear = (node: DirectoryTreeNode): void => {
        node.chartParent = null;
        node.chartChildren = [];
        for (const child of node.children) clear(child);
    };

    const connect = (
        node: DirectoryTreeNode,
        nearestChartParent: DirectoryTreeNode | null
    ): void => {
        let nextChartParent = nearestChartParent;
        if (isChartOwner(node)) {
            node.chartParent = nearestChartParent;
            nearestChartParent?.chartChildren.push(node);
            nextChartParent = node;
        }

        // The first non-split node owns its complete subtree, so no descendant
        // needs another chart. Split ancestors may still own shallow charts.
        if (!node.isSplit) return;
        for (const child of node.children) connect(child, nextChartParent);
    };

    clear(root);
    connect(root, null);
}

/**
 * A chart belongs either to the first non-split node on a branch or to a split
 * ancestor that must preserve its own direct files while routing downward.
 */
export function isChartOwner(node: DirectoryTreeNode): boolean {
    if (node.isSplit) return node.hasDirectFiles;
    return node.parent === null || node.parent.isSplit;
}

/** Return nodes in deepest-first post-order. */
export function getDeepestFirstNodes(root: DirectoryTreeNode): DirectoryTreeNode[] {
    const nodes: DirectoryTreeNode[] = [];

    const visit = (node: DirectoryTreeNode): void => {
        for (const child of node.children) visit(child);
        nodes.push(node);
    };

    visit(root);
    return nodes;
}

export function toDirectoryTreeRegistry(root: DirectoryTreeNode): DirectoryTreeRegistryNode {
    return {
        directory: root.directory,
        parent: root.parent?.directory ?? null,
        children: root.children.map(toDirectoryTreeRegistry),
        hasDirectFiles: root.hasDirectFiles,
        chartParent: root.chartParent?.directory ?? null,
        chartChildren: root.chartChildren.map(child => child.directory),
        chartTopologyVersion: CHART_TOPOLOGY_VERSION,
        thisDirectoryChars: root.thisDirectoryChars,
        isSplit: root.isSplit,
    };
}

function hydratePhysicalTree(
    saved: DirectoryTreeRegistryNode,
    parent: DirectoryTreeNode | null,
    nodes: Map<string, DirectoryTreeNode>
): DirectoryTreeNode {
    const node: DirectoryTreeNode = {
        directory: saved.directory,
        parent,
        children: [],
        // Registries written before direct-file charts were introduced do not
        // have this field. The legacy fallback rebuilds their virtual edges.
        hasDirectFiles: saved.hasDirectFiles ?? false,
        chartParent: null,
        chartChildren: [],
        thisDirectoryChars: saved.thisDirectoryChars,
        isSplit: saved.isSplit,
    };
    nodes.set(node.directory, node);
    node.children = saved.children.map(child => hydratePhysicalTree(child, node, nodes));
    return node;
}

function restoreNodeChartEdges(
    saved: DirectoryTreeRegistryNode,
    node: DirectoryTreeNode,
    nodes: ReadonlyMap<string, DirectoryTreeNode>
): boolean {
    if (
        saved.chartTopologyVersion !== CHART_TOPOLOGY_VERSION ||
        !Object.prototype.hasOwnProperty.call(saved, 'chartParent') ||
        !Array.isArray(saved.chartChildren)
    ) {
        return false;
    }

    const chartParent = saved.chartParent === null
        ? null
        : nodes.get(saved.chartParent);
    const chartChildren = saved.chartChildren.map(directory => nodes.get(directory));
    if (chartParent === undefined || chartChildren.some(child => child === undefined)) {
        return false;
    }

    node.chartParent = chartParent;
    node.chartChildren = chartChildren as DirectoryTreeNode[];
    return true;
}

function restorePersistedChartEdges(
    saved: DirectoryTreeRegistryNode,
    nodes: ReadonlyMap<string, DirectoryTreeNode>
): boolean {
    const node = nodes.get(saved.directory)!;
    let complete = restoreNodeChartEdges(saved, node, nodes);
    for (const child of saved.children) {
        if (!restorePersistedChartEdges(child, nodes)) complete = false;
    }
    return complete;
}

export function fromDirectoryTreeRegistry(
    registry: DirectoryTreeRegistryNode,
    parent: DirectoryTreeNode | null = null
): DirectoryTreeNode {
    const nodes = new Map<string, DirectoryTreeNode>();
    const root = hydratePhysicalTree(registry, parent, nodes);
    if (!restorePersistedChartEdges(registry, nodes)) rebuildChartTree(root);
    return root;
}
