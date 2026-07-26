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

/** Resolve forward file imports without performing reverse-edge inversion. */
export function resolveFileDependencies(
    fileNodes: readonly FileNode[],
    dependencyPaths: ReadonlySet<string>
): void {
    for (const fileNode of fileNodes) {
        const filePath = normalizePath(fileNode.relativePath);
        for (const dependency of fileNode.dependencies) {
            dependency.resolvedPath = resolveDependencyPath(
                filePath,
                dependency.source,
                dependencyPaths
            );
        }
    }
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

/** Serializable caller information shared from the global registry to chart workers. */
export interface GlobalReverseDependent {
    sourcePath: string;
    name: string;
    type: string;
    startIndex: number;
    startLine: number;
    endLine: number;
}

/** Immutable, project-relative reverse edges produced once per full build. */
export interface GlobalDependencyRegistry {
    reverseDependencies: ReadonlyMap<string, readonly GlobalReverseDependent[]>;
    /** First declaration offsets preserve local duplicate-name semantics. */
    targetSymbolOffsets: ReadonlyMap<string, number>;
}

function callerKey(sourcePath: string, symbol: FileSymbol): string {
    return `${sourcePath}\0${symbol.startIndex}`;
}

function incrementCount(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function formatGlobalDependent(dependent: GlobalReverseDependent): string {
    return dependent.type.includes('function') ? `${dependent.name}()` : dependent.name;
}

/**
 * Always include the caller source path. Add the source range/offset only
 * when one file contains duplicate caller names. Both passes are linear in
 * this target symbol's reverse-edge count.
 */
function formatReverseDependents(
    dependents: ReadonlyMap<string, ReverseDependent>
): string[] {
    const sourceLabelCounts = new Map<string, number>();

    for (const dependent of dependents.values()) {
        incrementCount(
            sourceLabelCounts,
            `${dependent.sourcePath}\0${dependent.label}`
        );
    }

    const formatted: string[] = [];
    for (const dependent of dependents.values()) {
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
 * Build the target-symbol lookup once before worker tasks traverse forward
 * calls. Duplicate names in one file deliberately retain the first symbol.
 */
export function createTargetSymbols(fileNodes: readonly FileNode[]): Map<string, number> {
    const targetSymbols = new Map<string, number>();
    for (const fileNode of fileNodes) {
        const filePath = normalizePath(fileNode.relativePath);
        for (const symbol of fileNode.symbols) {
            const key = symbolKey(filePath, symbol.name);
            if (!targetSymbols.has(key)) targetSymbols.set(key, symbol.startIndex);
        }
    }
    return targetSymbols;
}

/**
 * Return reverse-edge candidates for one independent worker task. The caller
 * merges these into the build-wide registry with constant-time Map writes.
 */
export function collectGlobalReverseDependencies(
    fileNodes: readonly FileNode[],
    dependencyPaths: ReadonlySet<string>,
    targetSymbolKeys: ReadonlySet<string>
): [string, GlobalReverseDependent][] {
    const entries: [string, GlobalReverseDependent][] = [];

    for (const sourceFile of fileNodes) {
        const sourcePath = normalizePath(sourceFile.relativePath);
        const importedSymbolByLocalName = new Map<string, string>();
        for (const dependency of sourceFile.dependencies) {
            const resolvedPath = resolveDependencyPath(
                sourcePath,
                dependency.source,
                dependencyPaths
            );
            if (!resolvedPath) continue;

            for (const binding of dependency.bindings) {
                const targetKey = symbolKey(resolvedPath, binding.imported);
                if (targetSymbolKeys.has(targetKey) && !importedSymbolByLocalName.has(binding.local)) {
                    importedSymbolByLocalName.set(binding.local, targetKey);
                }
            }
        }

        for (const caller of sourceFile.symbols) {
            const callerData: GlobalReverseDependent = {
                sourcePath,
                name: caller.name,
                type: caller.type,
                startIndex: caller.startIndex,
                startLine: caller.startLine,
                endLine: caller.endLine,
            };
            for (const dependencyName of caller.forwardDependencies) {
                const targetKey = importedSymbolByLocalName.get(dependencyName);
                if (targetKey) entries.push([targetKey, callerData]);
            }
        }
    }

    return entries;
}

/** Apply previously indexed project-wide callers to the symbols in one chart. */
export function applyGlobalReverseDependencies(
    fileNodes: FileNode[],
    registry: GlobalDependencyRegistry,
    chartDirectory: string = '.'
): FileNode[] {
    const normalizedDirectory = normalizePath(chartDirectory);

    for (const fileNode of fileNodes) {
        const localPath = normalizePath(fileNode.relativePath);
        const filePath = normalizedDirectory === '.'
            ? localPath
            : normalizePath(path.posix.join(normalizedDirectory, localPath));
        for (const symbol of fileNode.symbols) {
            const key = symbolKey(filePath, symbol.name);
            const dependents = registry.targetSymbolOffsets.get(key) === symbol.startIndex
                ? registry.reverseDependencies.get(key) ?? []
                : [];
            const uniqueDependents = new Map<string, ReverseDependent>();
            for (const dependent of dependents) {
                const label = formatGlobalDependent(dependent);
                uniqueDependents.set(
                    `${dependent.sourcePath}\0${dependent.startIndex}`,
                    {
                        sourcePath: dependent.sourcePath,
                        label,
                        symbol: {
                            ...symbol,
                            name: dependent.name,
                            type: dependent.type,
                            startIndex: dependent.startIndex,
                            startLine: dependent.startLine,
                            endLine: dependent.endLine,
                        },
                    }
                );
            }
            symbol.dependedOnBy = formatReverseDependents(uniqueDependents);
        }
    }
    return fileNodes;
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

    resolveFileDependencies(fileNodes, dependencyPaths);

    for (const fileNode of fileNodes) {
        const filePath = normalizePath(fileNode.relativePath);
        for (const symbol of fileNode.symbols) {
            symbol.dependedOnBy = [];
            reverseDependencies.set(symbol, new Map());
            const key = symbolKey(filePath, symbol.name);
            // Preserve the previous first-match behavior for duplicate names in one file.
            if (!symbolByKey.has(key)) symbolByKey.set(key, symbol);
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
