import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LazyWorkerPool } from './lazyWorkerPool.js';
import type { ChartRenderResult, ChartRenderTask } from './chartWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'chartWorker.js');

/** Runs independent partition charts, including reverse-dependency inversion. */
export class ChartWorkerPool {
    private readonly pool: LazyWorkerPool<ChartRenderTask, ChartRenderResult>;

    constructor(dependencyFiles: readonly string[]) {
        this.pool = new LazyWorkerPool({
            createWorker: () => new Worker(WORKER_PATH, {
                workerData: { dependencyFiles },
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
