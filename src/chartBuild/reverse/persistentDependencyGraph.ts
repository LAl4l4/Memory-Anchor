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

// =============================================================================
// Shared graph helpers
// =============================================================================

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

// =============================================================================
// Full-build graph creation
// =============================================================================

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

// =============================================================================
// Incremental graph reconciliation
// =============================================================================

interface CallerEntry {
    caller: GlobalReverseDependent;
    targetKeys: string[];
}

interface IncrementalGraphState {
    changedPaths: string[];
    currentNodesByPath: Map<string, FileNode>;
    oldCallerIds: string[];
    oldFileImporterPaths: string[];
    newCallers: Map<string, CallerEntry>;
    currentFileEntries: Map<string, string[]>;
    nextFiles: string[];
    dirtyFileImporterPaths: string[];
    affectedTargetKeys: Set<string>;
    targetOffsetKeys: Set<string>;
}

interface IncrementalGraphSnapshots {
    targetBefore: Map<string, string>;
    callerBefore: Map<string, string>;
    fileImporterBefore: Map<string, string>;
    targetOffsetBefore: Map<string, string>;
}

function collectChangedPaths(
    changedNodes: readonly FileNode[],
    changedFiles: readonly string[]
): string[] {
    return uniqueSorted([
        ...changedFiles.map(normalizePath),
        ...changedNodes.map(node => normalizePath(node.relativePath)),
    ]);
}

function collectNewCallers(
    entries: readonly [string, GlobalReverseDependent][]
): Map<string, CallerEntry> {
    const callers = new Map<string, CallerEntry>();
    for (const [targetKey, caller] of entries) {
        const id = callerKey(caller);
        const entry = callers.get(id) ?? { caller, targetKeys: [] };
        entry.targetKeys.push(targetKey);
        callers.set(id, entry);
    }
    return callers;
}

function collectChangedTargetKeys(
    graph: PersistentDependencyGraph,
    changedPaths: readonly string[],
    currentNodesByPath: ReadonlyMap<string, FileNode>
): Set<string> {
    const targetKeys = new Set<string>();
    for (const targetKey of Object.keys(graph.targetSymbolOffsets)) {
        if (changedPaths.some(filePath => pathKeyMatches(targetKey, filePath))) {
            targetKeys.add(targetKey);
        }
    }
    for (const [filePath, node] of currentNodesByPath) {
        for (const symbol of node.symbols) {
            targetKeys.add(symbolKey(filePath, symbol.name));
        }
    }
    return targetKeys;
}

function collectAffectedTargetKeys(
    graph: PersistentDependencyGraph,
    oldCallerIds: readonly string[],
    newCallers: ReadonlyMap<string, CallerEntry>,
    targetOffsetKeys: ReadonlySet<string>
): Set<string> {
    const targetKeys = new Set<string>(targetOffsetKeys);
    for (const callerId of oldCallerIds) {
        for (const targetKey of graph.forwardDependencies[callerId] ?? []) {
            targetKeys.add(targetKey);
        }
    }
    for (const { targetKeys: callerTargets } of newCallers.values()) {
        for (const targetKey of callerTargets) targetKeys.add(targetKey);
    }
    return targetKeys;
}

function collectDirtyFileImporterPaths(
    graph: PersistentDependencyGraph,
    nextFiles: readonly string[],
    dependencyPaths: ReadonlySet<string>
): string[] {
    const previousFileSet = new Set(graph.files);
    const nextFileSet = new Set(nextFiles);
    const changedDependencyPaths = uniqueSorted([
        ...previousFileSet,
        ...nextFileSet,
    ].filter(filePath => previousFileSet.has(filePath) !== nextFileSet.has(filePath)));
    return uniqueSorted(
        changedDependencyPaths.flatMap(targetPath =>
            graph.fileReverseDependencies[targetPath] ?? []
        ).filter(importerPath => dependencyPaths.has(importerPath))
    );
}

function collectIncrementalGraphState(
    graph: PersistentDependencyGraph,
    changedNodes: readonly FileNode[],
    changedFiles: readonly string[],
    dependencyPaths: ReadonlySet<string>
): IncrementalGraphState {
    const changedPaths = collectChangedPaths(changedNodes, changedFiles);
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
    const newCallers = collectNewCallers(currentEntries);
    const currentFileEntries = collectFileDependencyCandidates(changedNodes);
    const nextFiles = uniqueSorted(dependencyPaths);
    const targetOffsetKeys = collectChangedTargetKeys(
        graph,
        changedPaths,
        currentNodesByPath
    );

    return {
        changedPaths,
        currentNodesByPath,
        oldCallerIds,
        oldFileImporterPaths,
        newCallers,
        currentFileEntries,
        nextFiles,
        dirtyFileImporterPaths: collectDirtyFileImporterPaths(
            graph,
            nextFiles,
            dependencyPaths
        ),
        affectedTargetKeys: collectAffectedTargetKeys(
            graph,
            oldCallerIds,
            newCallers,
            targetOffsetKeys
        ),
        targetOffsetKeys,
    };
}

function captureIncrementalGraphSnapshots(
    graph: PersistentDependencyGraph,
    state: IncrementalGraphState
): IncrementalGraphSnapshots {
    const callerIds = [...state.oldCallerIds, ...state.newCallers.keys()];
    const importerPaths = [
        ...state.oldFileImporterPaths,
        ...state.currentFileEntries.keys(),
    ];
    return {
        targetBefore: new Map([...state.affectedTargetKeys].map(targetKey => [
            targetKey,
            targetSignature(graph, targetKey),
        ])),
        callerBefore: new Map(callerIds.map(callerId => [
            callerId,
            callerSignature(graph, callerId),
        ])),
        fileImporterBefore: new Map(importerPaths.map(importerPath => [
            importerPath,
            fileImporterSignature(graph, importerPath),
        ])),
        targetOffsetBefore: new Map([...state.targetOffsetKeys].map(targetKey => [
            targetKey,
            targetOffsetSignature(graph, targetKey),
        ])),
    };
}

function removeChangedCallers(
    graph: PersistentDependencyGraph,
    callerIds: readonly string[]
): void {
    for (const callerId of callerIds) removeCaller(graph, callerId);
}

function replaceChangedTargetOffsets(
    graph: PersistentDependencyGraph,
    state: IncrementalGraphState,
    snapshots: IncrementalGraphSnapshots
): void {
    for (const targetKey of state.targetOffsetKeys) {
        delete graph.targetSymbolOffsets[targetKey];
    }
    for (const [filePath, node] of state.currentNodesByPath) {
        for (const symbol of node.symbols) {
            const targetKey = symbolKey(filePath, symbol.name);
            state.targetOffsetKeys.add(targetKey);
            if (!snapshots.targetOffsetBefore.has(targetKey)) {
                snapshots.targetOffsetBefore.set(targetKey, '');
            }
            if (graph.targetSymbolOffsets[targetKey] === undefined) {
                graph.targetSymbolOffsets[targetKey] = symbol.startIndex;
            }
        }
    }
}

function replaceChangedCallers(
    graph: PersistentDependencyGraph,
    newCallers: ReadonlyMap<string, CallerEntry>
): void {
    for (const [callerId, { caller, targetKeys }] of newCallers) {
        addCaller(graph, callerId, caller, targetKeys);
    }
}

function replaceChangedFileImporters(
    graph: PersistentDependencyGraph,
    oldImporterPaths: readonly string[],
    currentFileEntries: ReadonlyMap<string, string[]>
): void {
    for (const importerPath of oldImporterPaths) {
        removeFileImporter(graph, importerPath);
    }
    for (const [importerPath, targetPaths] of currentFileEntries) {
        addFileImporter(graph, importerPath, targetPaths);
    }
}

function hasIncrementalGraphChanged(
    graph: PersistentDependencyGraph,
    snapshots: IncrementalGraphSnapshots
): boolean {
    for (const [callerId, signature] of snapshots.callerBefore) {
        if (callerSignature(graph, callerId) !== signature) return true;
    }
    for (const [importerPath, signature] of snapshots.fileImporterBefore) {
        if (fileImporterSignature(graph, importerPath) !== signature) return true;
    }
    for (const [targetKey, signature] of snapshots.targetOffsetBefore) {
        if (targetOffsetSignature(graph, targetKey) !== signature) return true;
    }
    return false;
}

function collectDirtyTargetKeys(
    graph: PersistentDependencyGraph,
    snapshots: IncrementalGraphSnapshots
): string[] {
    return [...snapshots.targetBefore.keys()].filter(targetKey => {
        if (snapshots.targetBefore.get(targetKey) !== targetSignature(graph, targetKey)) {
            return true;
        }
        return snapshots.targetOffsetBefore.has(targetKey) &&
            snapshots.targetOffsetBefore.get(targetKey) !== targetOffsetSignature(graph, targetKey) &&
            (graph.reverseDependencies[targetKey]?.length ?? 0) > 0;
    });
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
    const state = collectIncrementalGraphState(
        graph,
        changedNodes,
        changedFiles,
        dependencyPaths
    );
    const snapshots = captureIncrementalGraphSnapshots(graph, state);

    removeChangedCallers(graph, state.oldCallerIds);
    replaceChangedTargetOffsets(graph, state, snapshots);
    replaceChangedCallers(graph, state.newCallers);
    replaceChangedFileImporters(
        graph,
        state.oldFileImporterPaths,
        state.currentFileEntries
    );

    const filesChanged = JSON.stringify(graph.files) !== JSON.stringify(state.nextFiles);
    graph.files = state.nextFiles;

    return {
        changed: filesChanged || hasIncrementalGraphChanged(graph, snapshots),
        dirtyTargetKeys: collectDirtyTargetKeys(graph, snapshots),
        dirtyFileImporterPaths: state.dirtyFileImporterPaths,
    };
}
