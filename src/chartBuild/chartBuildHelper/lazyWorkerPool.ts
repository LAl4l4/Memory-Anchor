import { Worker } from 'node:worker_threads';

interface PendingTask<Request, Result> {
    request: Request;
    resolve: (result: Result) => void;
    reject: (error: unknown) => void;
}

export interface LazyWorkerPoolOptions<Result> {
    createWorker: () => Worker;
    getResult: (message: any) => Result;
    getError: (message: any) => Error;
}

/**
 * A demand-lazy worker queue shared by parsing and chart rendering. Workers
 * must post `{ type: 'ready' }` before they receive their first task.
 */
export class LazyWorkerPool<Request extends object, Result> {
    private workers: Worker[] = [];
    private queue: PendingTask<Request, Result>[] = [];
    private idle: Worker[] = [];
    private runningTasks = new Map<Worker, PendingTask<Request, Result>>();
    private workerStarts = new Set<Promise<void>>();
    private maxWorkers = 0;
    private startingWorkers = 0;
    private peakOutstandingTasks = 0;
    private destroying = false;

    constructor(private readonly options: LazyWorkerPoolOptions<Result>) {}

    async init(size: number): Promise<void> {
        if (!Number.isInteger(size) || size < 1) {
            throw new Error(`Worker pool size must be a positive integer, received ${size}`);
        }
        this.maxWorkers = size;
    }

    get activeWorkerCount(): number {
        return this.workers.length + this.startingWorkers;
    }

    get peakOutstandingTaskCount(): number {
        return this.peakOutstandingTasks;
    }

    private createWorker(): Promise<Worker> {
        return new Promise((resolve, reject) => {
            const worker = this.options.createWorker();
            let ready = false;

            worker.once('message', (message) => {
                if (message.type === 'ready') {
                    ready = true;
                    resolve(worker);
                } else {
                    reject(new Error('Worker init failed'));
                }
            });

            worker.on('message', (message) => {
                if (message.type === 'ready') return;
                const task = this.runningTasks.get(worker);
                if (task) {
                    this.runningTasks.delete(worker);
                    if (message.type === 'error') task.reject(this.options.getError(message));
                    else task.resolve(this.options.getResult(message));
                }
                this.idle.push(worker);
                this.drain();
            });

            worker.on('error', (error) => {
                const task = this.runningTasks.get(worker);
                if (task) {
                    this.runningTasks.delete(worker);
                    task.reject(error);
                } else if (!ready) {
                    reject(error);
                }
            });

            worker.on('exit', (code) => {
                this.removeDeadWorker(worker);
                const task = this.runningTasks.get(worker);
                if (task) {
                    this.runningTasks.delete(worker);
                    task.reject(new Error(`Worker exited with code ${code}`));
                }
                if (!ready) reject(new Error(`Worker exited during init with code ${code}`));
                if (!this.destroying) this.scaleToDemand();
            });
        });
    }

    private removeDeadWorker(worker: Worker): void {
        const workerIndex = this.workers.indexOf(worker);
        if (workerIndex !== -1) this.workers.splice(workerIndex, 1);
        const idleIndex = this.idle.indexOf(worker);
        if (idleIndex !== -1) this.idle.splice(idleIndex, 1);
    }

    private startWorkerIfNeeded(): boolean {
        if (this.destroying || this.maxWorkers === 0) return false;
        const outstanding = this.queue.length + this.runningTasks.size;
        const allocated = this.workers.length + this.startingWorkers;
        if (allocated >= this.maxWorkers || allocated >= outstanding) return false;

        this.startingWorkers += 1;
        let startPromise: Promise<void> | undefined;
        let reserved = true;
        startPromise = (async () => {
            let startError: unknown;
            try {
                const worker = await this.createWorker();
                if (this.destroying) {
                    await worker.terminate();
                    return;
                }
                this.startingWorkers -= 1;
                reserved = false;
                this.workers.push(worker);
                this.idle.push(worker);
                this.drain();
            } catch (error) {
                startError = error;
            } finally {
                if (reserved) this.startingWorkers -= 1;
                if (startPromise) this.workerStarts.delete(startPromise);
                if (startError && !this.destroying && this.workers.length === 0 && this.startingWorkers === 0) {
                    const error = startError instanceof Error ? startError : new Error(String(startError));
                    for (const task of this.queue.splice(0)) task.reject(error);
                }
                if (!this.destroying) this.scaleToDemand();
            }
        })();
        this.workerStarts.add(startPromise);
        return true;
    }

    private scaleToDemand(): void {
        while (this.startWorkerIfNeeded()) {
            // Slot reservation happens synchronously in startWorkerIfNeeded.
        }
    }

    private drain(): void {
        while (this.idle.length > 0 && this.queue.length > 0) {
            const worker = this.idle.pop()!;
            const task = this.queue.shift()!;
            this.runningTasks.set(worker, task);
            worker.postMessage(task.request);
        }
    }

    submit(request: Request): Promise<Result> {
        return new Promise((resolve, reject) => {
            if (this.destroying) {
                reject(new Error('Worker pool destroyed'));
                return;
            }
            this.queue.push({ request, resolve, reject });
            this.peakOutstandingTasks = Math.max(
                this.peakOutstandingTasks,
                this.queue.length + this.runningTasks.size
            );
            this.drain();
            this.scaleToDemand();
        });
    }

    async destroy(): Promise<void> {
        this.destroying = true;
        const error = new Error('Worker pool destroyed');
        for (const task of this.queue) task.reject(error);
        for (const task of this.runningTasks.values()) task.reject(error);
        this.queue = [];
        this.runningTasks.clear();
        await Promise.allSettled([
            ...this.workers.map(worker => worker.terminate()),
            ...this.workerStarts,
        ]);
        this.workers = [];
        this.idle = [];
        this.maxWorkers = 0;
    }
}
