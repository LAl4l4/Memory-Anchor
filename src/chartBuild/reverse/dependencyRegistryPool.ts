import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTargetSymbols } from './dependencyGraph.js';
import { LazyWorkerPool } from '../shared/lazyWorkerPool.js';
import { getWorkerExecArgv } from '../shared/workerExecArgv.js';
import type {
    FileNode,
    GlobalDependencyRegistry,
    GlobalReverseDependent,
    RegistryEntry,
} from '../shared/CBHTypes.js';

const __filename = fileURLToPath(import.meta.url);
const WORKER_PATH = path.join(path.dirname(__filename), 'dependencyRegistryWorker.js');

/**
 * Parallelizes the forward-call traversal while the owning thread performs
 * deterministic O(1) merges into the one project-wide reverse registry.
 */
export async function buildGlobalDependencyRegistry(
    fileNodes: readonly FileNode[],
    dependencyPaths: ReadonlySet<string>,
    workerCount: number
): Promise<GlobalDependencyRegistry> {
    if (fileNodes.length === 0) {
        return { reverseDependencies: new Map(), targetSymbolOffsets: new Map() };
    }

    // A registry task must amortize worker startup and its immutable path-set
    // clone. Small workspaces still get the same parallel pipeline, with one
    // lazy worker; large workspaces scale up to the shared CPU cap.
    const activeWorkerCount = Math.min(
        workerCount,
        Math.max(1, Math.ceil(fileNodes.length / 32))
    );
    const targetSymbols = createTargetSymbols(fileNodes);
    const pool = new LazyWorkerPool<FileNode[], RegistryEntry[]>({
        createWorker: () => new Worker(WORKER_PATH, {
            execArgv: getWorkerExecArgv(),
            workerData: {
                dependencyPaths: [...dependencyPaths],
            },
        }),
        getResult: message => message.entries as RegistryEntry[],
        getError: message => new Error(`Global dependency indexing failed: ${message.error}`),
    });
    const chunkSize = Math.max(1, Math.ceil(fileNodes.length / (activeWorkerCount * 4)));
    const chunks: FileNode[][] = [];
    for (let index = 0; index < fileNodes.length; index += chunkSize) {
        chunks.push(fileNodes.slice(index, index + chunkSize));
    }

    try {
        await pool.init(activeWorkerCount);
        const results = await Promise.all(chunks.map(chunk => pool.submit(chunk)));
        const reverseByTarget = new Map<string, Map<string, GlobalReverseDependent>>();
        for (const entries of results) {
            for (const [targetKey, caller] of entries) {
                let callers = reverseByTarget.get(targetKey);
                if (!callers) {
                    callers = new Map();
                    reverseByTarget.set(targetKey, callers);
                }
                callers.set(`${caller.sourcePath}\0${caller.startIndex}`, caller);
            }
        }
        return {
            reverseDependencies: new Map(
                [...reverseByTarget].map(([targetKey, callers]) => [
                    targetKey,
                    [...callers.values()],
                ])
            ),
            targetSymbolOffsets: targetSymbols,
        };
    } finally {
        await pool.destroy();
    }
}
