import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LazyWorkerPool } from '../shared/lazyWorkerPool.js';
import type { ChartRenderResult, ChartRenderTask, GlobalDependencyRegistry } from '../shared/CBHTypes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'chartWorker.js');

/** Runs independent partition charts, including reverse-dependency inversion. */
export class ChartWorkerPool {
    private readonly pool: LazyWorkerPool<ChartRenderTask, ChartRenderResult>;

    constructor(
        dependencyFiles: readonly string[],
        defaultDependencyPaths?: ReadonlySet<string>,
        globalDependencyRegistry?: GlobalDependencyRegistry
    ) {
        // Worker data is cloned per worker, rather than per queued task. This
        // lets registry sizing reuse one repository-wide dependency-path set.
        const workerData = {
            dependencyFiles,
            defaultDependencyPaths: defaultDependencyPaths
                ? [...defaultDependencyPaths]
                : undefined,
            globalDependencyRegistry,
        };
        this.pool = new LazyWorkerPool({
            createWorker: () => new Worker(WORKER_PATH, {
                workerData,
            }),
            getResult: message => message as ChartRenderResult,
            getError: message => new Error(
                `Chart render failed for ${message.chartPath}: ${message.error}`
            ),
        });
    }

    async init(size: number): Promise<void> {
        await this.pool.init(size);
    }

    render(task: ChartRenderTask): Promise<ChartRenderResult> {
        return this.pool.submit(task);
    }

    async destroy(): Promise<void> {
        await this.pool.destroy();
    }
}
