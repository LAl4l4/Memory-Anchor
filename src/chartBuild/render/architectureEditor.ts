import * as path from 'node:path';
import { formatSymbol } from '../parse/ASTParser.js';
import { getResolvedDependencyPaths } from '../reverse/dependencyGraph.js';
import type { FileNode, FileSymbol } from '../shared/CBHTypes.js';
import { getOrderedDirectoryFiles } from './skeletonEditor.js';

function formatSymbolChild(symbol: FileSymbol): string {
    const formatted = formatSymbol(symbol);
    return `  ${formatted.replace(/\n/g, '\n    ')}`;
}

function formatFileEntry(label: string, fileNode: FileNode | undefined): string {
    if (!fileNode) return `- ${label}`;

    const dependencies = getResolvedDependencyPaths(fileNode);
    const dependencySuffix = dependencies.length > 0 ? ` -> ${dependencies.join('; ')}` : '';
    const lines = [`- ${label}${dependencySuffix}`];

    fileNode.symbols.forEach(symbol => {
        if (symbol.type !== 'error') lines.push(formatSymbolChild(symbol));
    });
    return lines.join('\n');
}

/**
 * Render each file exactly once, with dependencies and symbols nested under
 * that single directory-tree entry.
 */
export function buildArchitectureSection(
    dirGroups: ReadonlyMap<string, readonly string[]>,
    fileNodes: readonly FileNode[]
): string {
    const nodesByPath = new Map(fileNodes.map(fileNode => [fileNode.relativePath, fileNode]));
    const groups: string[] = [];

    for (const { directory, files } of getOrderedDirectoryFiles(dirGroups)) {
        const entries = files.map(file => {
            const label = directory === '.' ? `/${file}` : path.basename(file);
            return formatFileEntry(label, nodesByPath.get(file));
        });
        if (entries.length === 0) continue;
        groups.push(directory === '.'
            ? entries.join('\n')
            : `### ${directory}/\n${entries.join('\n')}`);
    }

    const tree = groups.join('\n\n');
    return tree ? `## Architecture\n${tree}` : '## Architecture';
}
