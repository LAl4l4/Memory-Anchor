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

    for (const candidate of candidates) {
        if (dependencyPaths.has(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function symbolKey(filePath: string, symbolName: string): string {
    return `${normalizePath(filePath)}\0${symbolName}`;
}

function formatDependentSymbol(symbol: FileSymbol): string {
    return symbol.type.includes('function') ? `${symbol.name}()` : symbol.name;
}

interface ReverseDependent {
    sourcePath: string;
    symbol: FileSymbol;
    label: string;
}

function callerKey(sourcePath: string, symbol: FileSymbol): string {
    return `${sourcePath}\0${symbol.startIndex}`;
}

function incrementCount(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Keep unique caller names compact. Qualify collisions by path, and add the
 * source range/offset only when the same file contains duplicate symbol names.
 * Both passes are linear in this target symbol's reverse-edge count.
 */
function formatReverseDependents(
    dependents: ReadonlyMap<string, ReverseDependent>
): string[] {
    const labelCounts = new Map<string, number>();
    const sourceLabelCounts = new Map<string, number>();

    for (const dependent of dependents.values()) {
        incrementCount(labelCounts, dependent.label);
        incrementCount(
            sourceLabelCounts,
            `${dependent.sourcePath}\0${dependent.label}`
        );
    }

    const formatted: string[] = [];
    for (const dependent of dependents.values()) {
        if (labelCounts.get(dependent.label) === 1) {
            formatted.push(dependent.label);
            continue;
        }

        const sourceLabelKey = `${dependent.sourcePath}\0${dependent.label}`;
        if (sourceLabelCounts.get(sourceLabelKey) === 1) {
            formatted.push(`${dependent.sourcePath}:${dependent.label}`);
            continue;
        }

        formatted.push(
            `${dependent.sourcePath}:${dependent.label}` +
            `[L${dependent.symbol.startLine}-${dependent.symbol.endLine}` +
            `@${dependent.symbol.startIndex}]`
        );
    }
    return formatted;
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
    const symbolByKey = new Map<string, FileSymbol>();
    const reverseDependencies = new Map<FileSymbol, Map<string, ReverseDependent>>();

    for (const fileNode of fileNodes) {
        const filePath = normalizePath(fileNode.relativePath);
        for (const symbol of fileNode.symbols) {
            symbol.dependedOnBy = [];
            reverseDependencies.set(symbol, new Map());
            const key = symbolKey(filePath, symbol.name);
            // Preserve the previous first-match behavior for duplicate names in one file.
            if (!symbolByKey.has(key)) symbolByKey.set(key, symbol);
        }
        for (const dependency of fileNode.dependencies) {
            dependency.resolvedPath = resolveDependencyPath(
                filePath,
                dependency.source,
                dependencyPaths
            );
        }
    }

    for (const sourceFile of fileNodes) {
        const sourcePath = normalizePath(sourceFile.relativePath);
        const importedSymbolByLocalName = new Map<string, FileSymbol>();
        for (const dependency of sourceFile.dependencies) {
            if (!dependency.resolvedPath) continue;

            for (const binding of dependency.bindings) {
                const targetSymbol = symbolByKey.get(symbolKey(
                    dependency.resolvedPath,
                    binding.imported
                ));
                if (targetSymbol && !importedSymbolByLocalName.has(binding.local)) {
                    importedSymbolByLocalName.set(binding.local, targetSymbol);
                }
            }
        }

        for (const caller of sourceFile.symbols) {
            const label = formatDependentSymbol(caller);
            for (const dependencyName of caller.forwardDependencies) {
                const targetSymbol = importedSymbolByLocalName.get(dependencyName);
                if (!targetSymbol) continue;
                reverseDependencies.get(targetSymbol)!.set(
                    callerKey(sourcePath, caller),
                    { sourcePath, symbol: caller, label }
                );
            }
        }
    }

    for (const [symbol, dependents] of reverseDependencies) {
        symbol.dependedOnBy.push(...formatReverseDependents(dependents));
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
