import { parentPort, workerData } from 'node:worker_threads';
import {
    collectGlobalReverseDependencies,
} from './dependencyGraph.js';
import type { FileNode } from './symbolExtractor.js';

interface RegistryWorkerData {
    dependencyPaths: string[];
    targetSymbolKeys: string[];
}

const { dependencyPaths, targetSymbolKeys } = workerData as RegistryWorkerData;
const availablePaths = new Set(dependencyPaths);
const availableTargets = new Set(targetSymbolKeys);

parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (fileNodes: FileNode[]) => {
    try {
        parentPort!.postMessage({
            entries: collectGlobalReverseDependencies(fileNodes, availablePaths, availableTargets),
        });
    } catch (error) {
        parentPort!.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
