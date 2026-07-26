import * as path from 'node:path';
import { FileNode, FileSymbol } from './symbolExtractor.js';

const RESOLVABLE_EXTENSIONS = [
    '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java',
    '.c', '.cpp', '.h', '.go', '.rs', '.php', '.rb', '.kt', '.swift', '.cs',
];

function normalizePath(value: string): string {
    return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function resolveDependencyPath(
    fromFile: string,
    source: string,
    dependencyPaths: ReadonlySet<string>
): string | undefined {
    // Package imports remain unresolved; relative imports can target any
    // parseable repository file, including files outside this chart.
    if (!source.startsWith('.')) return undefined;

    const base = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), source)));
    const candidates = new Set<string>([base]);
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.add(`${base}${extension}`);

    const extension = path.posix.extname(base);
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
        candidates.add(`${base.slice(0, -extension.length)}.ts`);
        candidates.add(`${base.slice(0, -extension.length)}.tsx`);
    }
    for (const candidateExtension of RESOLVABLE_EXTENSIONS.slice(1)) {
        candidates.add(`${base}/index${candidateExtension}`);
    }

    return [...candidates].find(candidate => dependencyPaths.has(candidate));
}

function getContainingSymbol(symbols: readonly FileSymbol[], position: number): FileSymbol | undefined {
    return symbols
        .filter(symbol => symbol.startIndex <= position && position <= symbol.endIndex)
        .sort((left, right) => (left.endIndex - left.startIndex) - (right.endIndex - right.startIndex))[0];
}

function formatDependentSymbol(symbol: FileSymbol): string {
    return symbol.type.includes('function') ? `${symbol.name}()` : symbol.name;
}

/**
 * Resolve file imports against every parseable repository file, then annotate
 * symbols with reverse callers from this chart only. FileNodes are mutated so
 * the same parsed batch can drive both the skeleton and the node section.
 */
export function buildChartDependencyGraph(
    fileNodes: FileNode[],
    dependencyPaths: ReadonlySet<string> = new Set(
        fileNodes.map(fileNode => normalizePath(fileNode.relativePath))
    )
): FileNode[] {
    const byPath = new Map(fileNodes.map(fileNode => [normalizePath(fileNode.relativePath), fileNode]));

    for (const fileNode of fileNodes) {
        for (const symbol of fileNode.symbols) symbol.dependedOnBy = [];
        for (const dependency of fileNode.dependencies) {
            dependency.resolvedPath = resolveDependencyPath(
                fileNode.relativePath,
                dependency.source,
                dependencyPaths
            );
        }
    }

    for (const sourceFile of fileNodes) {
        for (const dependency of sourceFile.dependencies) {
            if (!dependency.resolvedPath) continue;
            const targetFile = byPath.get(dependency.resolvedPath);
            if (!targetFile) continue;

            for (const binding of dependency.bindings) {
                const targetSymbol = targetFile.symbols.find(symbol => symbol.name === binding.imported);
                if (!targetSymbol) continue;

                for (const call of sourceFile.calls) {
                    if (call.name !== binding.local) continue;
                    const caller = getContainingSymbol(sourceFile.symbols, call.startIndex);
                    if (!caller) continue;
                    const label = formatDependentSymbol(caller);
                    if (!targetSymbol.dependedOnBy.includes(label)) {
                        targetSymbol.dependedOnBy.push(label);
                    }
                }
            }
        }
    }

    return fileNodes;
}

export function getResolvedDependencyPaths(fileNode: FileNode): string[] {
    return [...new Set(
        fileNode.dependencies
            .map(dependency => dependency.resolvedPath)
            .filter((dependency): dependency is string => Boolean(dependency))
    )];
}
