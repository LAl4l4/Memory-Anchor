import { parentPort, workerData } from 'node:worker_threads';
import {
    collectGlobalReverseDependencies,
} from './dependencyGraph.js';
import type { FileNode, RegistryWorkerData } from '../shared/CBHTypes.js';

const { dependencyPaths } = workerData as RegistryWorkerData;
const availablePaths = new Set(dependencyPaths);

parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (fileNodes: FileNode[]) => {
    try {
        parentPort!.postMessage({
            entries: collectGlobalReverseDependencies(fileNodes, availablePaths),
        });
    } catch (error) {
        parentPort!.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
