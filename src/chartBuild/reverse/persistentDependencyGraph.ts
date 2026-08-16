import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collectFileDependencyCandidates,
    collectGlobalReverseDependencies,
    createTargetSymbols,
} from './dependencyGraph.js';
import type {
    FileNode,
    GlobalDependencyRegistry,
    GlobalReverseDependent,
    PersistentDependencyGraph,
    PersistentDependencyGraphUpdate,
} from '../shared/CBHTypes.js';

export const DEPENDENCY_GRAPH_FILE_NAME = 'dependencyGraph.json';

const GRAPH_VERSION = 2 as const;

function normalizePath(value: string): string {
    return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function symbolKey(filePath: string, symbolName: string): string {
    return `${normalizePath(filePath)}\0${symbolName}`;
}

function callerKey(caller: GlobalReverseDependent): string {
    return `${normalizePath(caller.sourcePath)}\0${caller.startIndex}`;
}

function pathKeyMatches(key: string, filePath: string): boolean {
    return key.startsWith(`${normalizePath(filePath)}\0`);
}

function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function cloneCaller(caller: GlobalReverseDependent): GlobalReverseDependent {
    return {
        sourcePath: normalizePath(caller.sourcePath),
        name: caller.name,
        type: caller.type,
        startIndex: caller.startIndex,
        startLine: caller.startLine,
        endLine: caller.endLine,
    };
}

function hasStringArrayRecord(value: unknown): value is Record<string, string[]> {
    return Boolean(value) && typeof value === 'object' &&
        Object.values(value as Record<string, unknown>).every(entry =>
            Array.isArray(entry) && entry.every(item => typeof item === 'string')
        );
}

function hasNumberRecord(value: unknown): value is Record<string, number> {
    return Boolean(value) && typeof value === 'object' &&
        Object.values(value as Record<string, unknown>).every(entry =>
            typeof entry === 'number' && Number.isInteger(entry)
        );
}

function hasCallerRecord(value: unknown): value is Record<string, GlobalReverseDependent> {
    return Boolean(value) && typeof value === 'object' &&
        Object.values(value as Record<string, unknown>).every(entry => {
            if (!entry || typeof entry !== 'object') return false;
            const caller = entry as Partial<GlobalReverseDependent>;
            return typeof caller.sourcePath === 'string' &&
                typeof caller.name === 'string' &&
                typeof caller.type === 'string' &&
                Number.isInteger(caller.startIndex) &&
                Number.isInteger(caller.startLine) &&
                Number.isInteger(caller.endLine);
        });
}

function isGraph(value: unknown): value is PersistentDependencyGraph {
    if (!value || typeof value !== 'object') return false;
    const graph = value as Partial<PersistentDependencyGraph>;
    return graph.version === GRAPH_VERSION &&
        Array.isArray(graph.files) && graph.files.every(file => typeof file === 'string') &&
        hasStringArrayRecord(graph.forwardDependencies) &&
        hasStringArrayRecord(graph.reverseDependencies) &&
        hasCallerRecord(graph.callerSymbols) &&
        hasNumberRecord(graph.targetSymbolOffsets) &&
        hasStringArrayRecord(graph.fileForwardDependencies) &&
        hasStringArrayRecord(graph.fileReverseDependencies);
}

function targetSignature(graph: PersistentDependencyGraph, targetKey: string): string {
    return (graph.reverseDependencies[targetKey] ?? [])
        .map(callerId => `${callerId}\0${JSON.stringify(graph.callerSymbols[callerId] ?? null)}`)
        .sort((left, right) => left.localeCompare(right))
        .join('\n');
}

function callerSignature(graph: PersistentDependencyGraph, callerId: string): string {
    return JSON.stringify({
        targets: graph.forwardDependencies[callerId] ?? [],
        caller: graph.callerSymbols[callerId] ?? null,
    });
}

function fileImporterSignature(
    graph: PersistentDependencyGraph,
    importerPath: string
): string {
    return JSON.stringify(graph.fileForwardDependencies[importerPath] ?? []);
}

function targetOffsetSignature(graph: PersistentDependencyGraph, targetKey: string): string {
    const offset = graph.targetSymbolOffsets[targetKey];
    return offset === undefined ? '' : String(offset);
}

function removeCaller(graph: PersistentDependencyGraph, callerId: string): void {
    for (const targetKey of graph.forwardDependencies[callerId] ?? []) {
        const callers = graph.reverseDependencies[targetKey] ?? [];
        const next = callers.filter(candidate => candidate !== callerId);
        if (next.length === 0) delete graph.reverseDependencies[targetKey];
        else graph.reverseDependencies[targetKey] = next;
    }
    delete graph.forwardDependencies[callerId];
    delete graph.callerSymbols[callerId];
}

function addCaller(
    graph: PersistentDependencyGraph,
    callerId: string,
    caller: GlobalReverseDependent,
    targetKeys: readonly string[]
): void {
    const targets = uniqueSorted(targetKeys);
    if (targets.length === 0) return;

    graph.forwardDependencies[callerId] = targets;
    graph.callerSymbols[callerId] = cloneCaller(caller);
    for (const targetKey of targets) {
        graph.reverseDependencies[targetKey] = uniqueSorted([
            ...(graph.reverseDependencies[targetKey] ?? []),
            callerId,
        ]);
    }
}

function removeFileImporter(
    graph: PersistentDependencyGraph,
    importerPath: string
): void {
    for (const targetPath of graph.fileForwardDependencies[importerPath] ?? []) {
        const importers = graph.fileReverseDependencies[targetPath] ?? [];
        const next = importers.filter(candidate => candidate !== importerPath);
        if (next.length === 0) delete graph.fileReverseDependencies[targetPath];
        else graph.fileReverseDependencies[targetPath] = next;
    }
    delete graph.fileForwardDependencies[importerPath];
}

function addFileImporter(
    graph: PersistentDependencyGraph,
    importerPath: string,
    targetPaths: readonly string[]
): void {
    const targets = uniqueSorted(targetPaths);
    if (targets.length === 0) return;

    graph.fileForwardDependencies[importerPath] = targets;
    for (const targetPath of targets) {
        graph.fileReverseDependencies[targetPath] = uniqueSorted([
            ...(graph.fileReverseDependencies[targetPath] ?? []),
            importerPath,
        ]);
    }
}

/**
 * Build the durable forward and reverse maps from the full-build registry.
 * The registry deliberately retains candidates for imports whose matching
 * target symbol does not exist yet, so a later target addition needs no
 * repository-wide reverse traversal.
 */
export function createPersistentDependencyGraph(
    fileNodes: readonly FileNode[],
    dependencyFiles: Iterable<string>,
    registry: GlobalDependencyRegistry
): PersistentDependencyGraph {
    const graph: PersistentDependencyGraph = {
        version: GRAPH_VERSION,
        files: uniqueSorted(dependencyFiles),
        forwardDependencies: {},
        reverseDependencies: {},
        callerSymbols: {},
        targetSymbolOffsets: Object.fromEntries(registry.targetSymbolOffsets),
        fileForwardDependencies: {},
        fileReverseDependencies: {},
    };

    const callers = new Map<string, {
        caller: GlobalReverseDependent;
        targetKeys: string[];
    }>();
    for (const [targetKey, reverseCallers] of registry.reverseDependencies) {
        for (const caller of reverseCallers) {
            const id = callerKey(caller);
            const entry = callers.get(id) ?? { caller, targetKeys: [] };
            entry.targetKeys.push(targetKey);
            callers.set(id, entry);
        }
    }
    for (const [id, { caller, targetKeys }] of callers) {
        addCaller(graph, id, caller, targetKeys);
    }
    for (const [importerPath, targetPaths] of collectFileDependencyCandidates(fileNodes)) {
        addFileImporter(graph, importerPath, targetPaths);
    }

    // Keep target offsets exact even when a compatibility caller supplies a
    // registry without them.
    if (Object.keys(graph.targetSymbolOffsets).length === 0) {
        graph.targetSymbolOffsets = Object.fromEntries(createTargetSymbols(fileNodes));
    }
    return graph;
}

/** Convert the serializable graph back into the renderer's Map-based view. */
export function createGlobalDependencyRegistry(
    graph: PersistentDependencyGraph
): GlobalDependencyRegistry {
    return {
        reverseDependencies: new Map(Object.entries(graph.reverseDependencies).map(
            ([targetKey, callerIds]) => [
                targetKey,
                callerIds
                    .map(callerId => graph.callerSymbols[callerId])
                    .filter((caller): caller is GlobalReverseDependent => Boolean(caller))
                    .map(cloneCaller),
            ]
        )),
        targetSymbolOffsets: new Map(Object.entries(graph.targetSymbolOffsets)),
    };
}

export function loadPersistentDependencyGraph(
    graphPath: string
): PersistentDependencyGraph | null {
    try {
        const value = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as unknown;
        return isGraph(value) ? value : null;
    } catch {
        return null;
    }
}

export function persistDependencyGraph(
    graphPath: string,
    graph: PersistentDependencyGraph
): void {
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    const temporaryPath = `${graphPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');
    fs.renameSync(temporaryPath, graphPath);
}

/**
 * Reconcile changed source files through their persisted symbol and file
 * forward edges. Neither reverse map is scanned globally; the returned dirty
 * paths identify exactly the reverse-caller and forward-import charts whose
 * rendered dependency annotations can have changed.
 */
export function updatePersistentDependencyGraph(
    graph: PersistentDependencyGraph,
    changedNodes: readonly FileNode[],
    changedFiles: readonly string[],
    dependencyPaths: ReadonlySet<string>
): PersistentDependencyGraphUpdate {
    const changedPaths = uniqueSorted([
        ...changedFiles.map(normalizePath),
        ...changedNodes.map(node => normalizePath(node.relativePath)),
    ]);
    const currentNodesByPath = new Map(changedNodes.map(node => [
        normalizePath(node.relativePath), node,
    ]));
    const oldCallerIds = Object.keys(graph.forwardDependencies).filter(callerId =>
        changedPaths.some(filePath => pathKeyMatches(callerId, filePath))
    );
    const oldFileImporterPaths = Object.keys(graph.fileForwardDependencies).filter(
        importerPath => changedPaths.some(filePath => importerPath === filePath)
    );
    const currentEntries = collectGlobalReverseDependencies(
        changedNodes,
        dependencyPaths
    );
    const newCallers = new Map<string, {
        caller: GlobalReverseDependent;
        targetKeys: string[];
    }>();
    for (const [targetKey, caller] of currentEntries) {
        const id = callerKey(caller);
        const entry = newCallers.get(id) ?? { caller, targetKeys: [] };
        entry.targetKeys.push(targetKey);
        newCallers.set(id, entry);
    }
    const currentFileEntries = collectFileDependencyCandidates(changedNodes);
    const nextFiles = uniqueSorted(dependencyPaths);
    const previousFileSet = new Set(graph.files);
    const nextFileSet = new Set(nextFiles);
    const changedDependencyPaths = uniqueSorted([
        ...previousFileSet,
        ...nextFileSet,
    ].filter(filePath => previousFileSet.has(filePath) !== nextFileSet.has(filePath)));
    const dirtyFileImporterPaths = uniqueSorted(
        changedDependencyPaths.flatMap(targetPath =>
            graph.fileReverseDependencies[targetPath] ?? []
        ).filter(importerPath => dependencyPaths.has(importerPath))
    );

    const affectedTargetKeys = new Set<string>();
    for (const callerId of oldCallerIds) {
        for (const targetKey of graph.forwardDependencies[callerId] ?? []) {
            affectedTargetKeys.add(targetKey);
        }
    }
    for (const { targetKeys } of newCallers.values()) {
        for (const targetKey of targetKeys) affectedTargetKeys.add(targetKey);
    }

    // A target declaration can appear after callers were already persisted.
    // Include both removed and newly parsed declarations in the dirty set so
    // an unchanged reverse list still rerenders when its target becomes
    // renderable (or ceases to be renderable).
    const targetOffsetKeys = new Set<string>();
    for (const targetKey of Object.keys(graph.targetSymbolOffsets)) {
        if (changedPaths.some(filePath => pathKeyMatches(targetKey, filePath))) {
            targetOffsetKeys.add(targetKey);
        }
    }
    for (const [filePath, node] of currentNodesByPath) {
        for (const symbol of node.symbols) {
            targetOffsetKeys.add(symbolKey(filePath, symbol.name));
        }
    }
    for (const targetKey of targetOffsetKeys) affectedTargetKeys.add(targetKey);

    const targetBefore = new Map([...affectedTargetKeys].map(targetKey => [
        targetKey,
        targetSignature(graph, targetKey),
    ]));
    const callerBefore = new Map<string, string>();
    for (const callerId of [...oldCallerIds, ...newCallers.keys()]) {
        callerBefore.set(callerId, callerSignature(graph, callerId));
    }
    const fileImporterBefore = new Map<string, string>();
    for (const importerPath of [...oldFileImporterPaths, ...currentFileEntries.keys()]) {
        fileImporterBefore.set(importerPath, fileImporterSignature(graph, importerPath));
    }
    const targetOffsetBefore = new Map([...targetOffsetKeys].map(targetKey => [
        targetKey,
        targetOffsetSignature(graph, targetKey),
    ]));

    for (const callerId of oldCallerIds) removeCaller(graph, callerId);
    for (const targetKey of targetOffsetKeys) delete graph.targetSymbolOffsets[targetKey];
    for (const [filePath, node] of currentNodesByPath) {
        for (const symbol of node.symbols) {
            const targetKey = symbolKey(filePath, symbol.name);
            targetOffsetKeys.add(targetKey);
            if (!targetOffsetBefore.has(targetKey)) targetOffsetBefore.set(targetKey, '');
            if (graph.targetSymbolOffsets[targetKey] === undefined) {
                graph.targetSymbolOffsets[targetKey] = symbol.startIndex;
            }
        }
    }
    for (const [callerId, { caller, targetKeys }] of newCallers) {
        addCaller(graph, callerId, caller, targetKeys);
    }
    for (const importerPath of oldFileImporterPaths) {
        removeFileImporter(graph, importerPath);
    }
    for (const [importerPath, targetPaths] of currentFileEntries) {
        addFileImporter(graph, importerPath, targetPaths);
    }

    const filesChanged = JSON.stringify(graph.files) !== JSON.stringify(nextFiles);
    graph.files = nextFiles;

    const graphChanged = filesChanged ||
        [...callerBefore].some(([callerId, signature]) =>
            callerSignature(graph, callerId) !== signature
        ) ||
        [...fileImporterBefore].some(([importerPath, signature]) =>
            fileImporterSignature(graph, importerPath) !== signature
        ) ||
        [...targetOffsetBefore].some(([targetKey, signature]) =>
            targetOffsetSignature(graph, targetKey) !== signature
        );
    const dirtyTargetKeys = [...affectedTargetKeys].filter(targetKey => {
        if (targetBefore.get(targetKey) !== targetSignature(graph, targetKey)) {
            return true;
        }
        return targetOffsetBefore.has(targetKey) &&
            targetOffsetBefore.get(targetKey) !== targetOffsetSignature(graph, targetKey) &&
            (graph.reverseDependencies[targetKey]?.length ?? 0) > 0;
    });
    return { changed: graphChanged, dirtyTargetKeys, dirtyFileImporterPaths };
}
