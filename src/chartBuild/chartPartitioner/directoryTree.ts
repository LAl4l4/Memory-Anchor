export interface DirectoryCharThresholds {
    splitAt: number;
    mergeAt: number;
}

export const DIRECTORY_CHAR_THRESHOLDS: Readonly<DirectoryCharThresholds> = {
    splitAt: 12000,
    mergeAt: 9000,
};

/** Runtime node. `parent` is retained for bottom-up traversal. */
export interface DirectoryTreeNode {
    directory: string;
    parent: DirectoryTreeNode | null;
    children: DirectoryTreeNode[];
    thisDirectoryChars: number;
    isSplit: boolean;
}

/** JSON-safe registry node; parent is stored as a directory path. */
export interface DirectoryTreeRegistryNode {
    directory: string;
    parent: string | null;
    children: DirectoryTreeRegistryNode[];
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
        thisDirectoryChars: 0,
        isSplit: false,
    };
}

function normalizeDirectory(directory: string): string {
    return directory.split('\\').join('/');
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
    }

    for (const node of nodes.values()) {
        node.children.sort((a, b) => a.directory.localeCompare(b.directory));
    }

    return root;
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
        thisDirectoryChars: root.thisDirectoryChars,
        isSplit: root.isSplit,
    };
}

export function fromDirectoryTreeRegistry(
    registry: DirectoryTreeRegistryNode,
    parent: DirectoryTreeNode | null = null
): DirectoryTreeNode {
    const node: DirectoryTreeNode = {
        directory: registry.directory,
        parent,
        children: [],
        thisDirectoryChars: registry.thisDirectoryChars,
        isSplit: registry.isSplit,
    };
    node.children = registry.children.map(child => fromDirectoryTreeRegistry(child, node));
    return node;
}
