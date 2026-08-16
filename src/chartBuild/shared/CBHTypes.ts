import type { Stats } from 'node:fs';
import type { Worker } from 'node:worker_threads';

/** Serializable symbol and dependency data extracted from one source file. */
export interface FileSymbol {
    type: string;
    name: string;
    startIndex: number;
    endIndex: number;
    startLine: number;
    endLine: number;
    /** Present only for exported functions, where it can avoid a source read. */
    parameters?: string;
    /** Present only for exported functions with an explicit source annotation. */
    returnType?: string;
    /** Deduplicated bare call names made by this symbol, collected in the AST worker. */
    forwardDependencies: string[];
    dependedOnBy: string[];
}

export interface FileDependencyBinding {
    imported: string;
    local: string;
}

export interface FileDependency {
    source: string;
    bindings: FileDependencyBinding[];
    resolvedPath?: string;
}

export interface FileNode {
    relativePath: string;
    language: string;
    symbols: FileSymbol[];
    dependencies: FileDependency[];
}

export interface ChartFile {
    absolutePath: string;
    relativePath: string;
}

export type ChartParseCache = Map<string, FileNode>;

export interface ReverseDependent {
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

/**
 * Serializable project-wide dependency state retained between incremental
 * refreshes. Forward edges are keyed by caller instance; reverse edges are
 * their exact inverse and are used only to render the target chart.
 */
export interface PersistentDependencyGraph {
    version: 2;
    /** Every parseable project file, relative to the workspace root. */
    files: string[];
    /** caller path + NUL + start offset -> target symbol keys. */
    forwardDependencies: Record<string, string[]>;
    /** target path + NUL + symbol name -> caller instance keys. */
    reverseDependencies: Record<string, string[]>;
    /** Display data for caller instances that have at least one forward edge. */
    callerSymbols: Record<string, GlobalReverseDependent>;
    /** First declaration offsets preserve duplicate-name target semantics. */
    targetSymbolOffsets: Record<string, number>;
    /** Importer file -> every relative file path its imports could resolve to. */
    fileForwardDependencies: Record<string, string[]>;
    /** Candidate target path -> importer files whose rendered `->` may change. */
    fileReverseDependencies: Record<string, string[]>;
}

export interface PersistentDependencyGraphUpdate {
    changed: boolean;
    /** Target symbol keys whose rendered reverse-caller list changed. */
    dirtyTargetKeys: string[];
    /** Importer paths whose rendered forward file edge may have changed. */
    dirtyFileImporterPaths: string[];
}

export interface PendingTask<Request, Result> {
    request: Request;
    resolve: (result: Result) => void;
    reject: (error: unknown) => void;
}

export interface LazyWorkerPoolOptions<Result> {
    createWorker: () => Worker;
    getResult: (message: any) => Result;
    getError: (message: any) => Error;
}

export interface ParseRequest extends ChartFile {
    lang: string;
}

export interface ChartWorkerData {
    dependencyFiles: string[];
    /** Paths relative to the shared source directory for this worker batch. */
    defaultDependencyPaths?: string[];
    globalDependencyRegistry?: GlobalDependencyRegistry;
}

/** CPU and write timings returned by one chart-render worker task. */
export interface ChartRenderTiming {
    dependencyMs: number;
    skeletonMs: number;
    nodesMs: number;
    assemblyMs: number;
    writeMs: number;
}

export interface ChartRenderTask {
    chartPath?: string;
    sourceDirectory: string;
    dirGroups: [string, string[]][];
    fileNodes: FileNode[];
    chartHeading: string;
    childChartsSection: string;
    writeOutput: boolean;
    dependencyPaths?: string[];
    /** Project-relative directory containing this chart's local paths. */
    chartDirectory?: string;
}

export interface ChartRenderResult {
    chartPath?: string;
    contentLength: number;
    timing?: ChartRenderTiming;
}

export type RegistryEntry = [string, GlobalReverseDependent];

export interface RegistryWorkerData {
    dependencyPaths: string[];
}

export interface PendingFileParse {
    file: string;
    absPath: string;
    stats: Stats;
}

export interface ClassifiedFiles {
    toDelete: string[];
    toParse: PendingFileParse[];
}

export interface ParsedFileResult {
    file: string;
    stats: Stats;
    newNodeContent: string;
}

export interface PartitionChartUpdateResult {
    changed: boolean;
    previousChars: number;
    currentChars: number;
    graphChanged?: boolean;
    dirtyTargetKeys?: string[];
}

export interface WorkspacePaths {
    anchorDir: string;
    projectRoot: string;
    chartPath: string;
}
