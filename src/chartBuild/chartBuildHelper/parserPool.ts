import { Worker } from 'worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileNode } from './symbolExtractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'parserWorker.js');

interface Task {
    absolutePath: string;
    relativePath: string;
    lang: string;
    resolve: (result: FileNode) => void;
    reject: (err: unknown) => void;
}

export class ParserWorkerPool {
    private workers: Worker[] = [];
    private queue: Task[] = [];
    private idle: Worker[] = [];
    private runningTasks = new Map<Worker, Task>();
    private workerStarts = new Set<Promise<void>>();
    private maxWorkers = 0;
    private startingWorkers = 0;
    private peakOutstandingTasks = 0;
    private destroying = false;

    async init(size: number) {
        if (!Number.isInteger(size) || size < 1) {
            throw new Error(`ParserWorkerPool size must be a positive integer, received ${size}`);
        }
        this.maxWorkers = size;
    }

    /** Exposed for lifecycle diagnostics and regression tests. */
    get activeWorkerCount(): number {
        return this.workers.length + this.startingWorkers;
    }

    /** Highest queued + running task count, useful for capacity diagnostics. */
    get peakOutstandingTaskCount(): number {
        return this.peakOutstandingTasks;
    }

    private createWorker(): Promise<Worker> {
        return new Promise((resolve, reject) => {
            const worker = new Worker(WORKER_PATH);
            let ready = false;

            // worker 发来 ready 信号说明 Parser.init() 完成了
            worker.once('message', (msg) => {
                if (msg.type === 'ready') {
                    ready = true;
                    resolve(worker);
                }
                else reject(new Error('Worker init failed'));
            });

            // worker 处理完任务后的回调
            worker.on('message', (msg) => {
                if (msg.type === 'ready') return; // 已处理
                
                // 找到对应的 resolve
                const task = this.runningTasks.get(worker);
                if (task) {
                    this.runningTasks.delete(worker);
                    if (msg.type === 'error') {
                        task.reject(new Error(`Parse failed for ${msg.file}: ${msg.error}`));
                    } else {
                        task.resolve(msg.fileNode);
                    }
                }

                // worker 空闲，取下一个任务
                this.idle.push(worker);
                this.drain();
            });

            // 运行时错误：reject 当前正在跑的任务，而不是只在 init 阶段有效
            worker.on('error', (err) => {
                const task = this.runningTasks.get(worker);
                if (task) {
                    this.runningTasks.delete(worker);
                    task.reject(err);
                } else if (!ready) reject(err);
            });

            worker.on('exit', (code) => {
                // 移除已死亡的 worker，避免 drain 把任务派给死线程
                this.removeDeadWorker(worker);

                // 拒绝尚未完成的任务（可能已被 'error' 拒绝过，二次 reject 无副作用）
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

    private removeDeadWorker(worker: Worker): boolean {
        const wIdx = this.workers.indexOf(worker);
        if (wIdx !== -1) this.workers.splice(wIdx, 1);
        const iIdx = this.idle.indexOf(worker);
        if (iIdx !== -1) this.idle.splice(iIdx, 1);
        return wIdx !== -1;
    }

    /**
     * Atomically reserve one bounded worker slot before starting it.
     * This is the only worker-creation entry, so no caller can exceed maxWorkers.
     */
    private startWorkerIfNeeded(): boolean {
        if (this.destroying || this.maxWorkers === 0) return false;

        const outstandingTasks = this.queue.length + this.runningTasks.size;
        const allocatedWorkers = this.workers.length + this.startingWorkers;
        if (
            allocatedWorkers >= this.maxWorkers ||
            allocatedWorkers >= outstandingTasks
        ) {
            return false;
        }

        this.startingWorkers += 1;
        let startPromise: Promise<void> | undefined;
        let startingSlotReserved = true;
        startPromise = (async () => {
            let startError: unknown;
            try {
                const worker = await this.createWorker();
                if (this.destroying) {
                    await worker.terminate();
                    return;
                }
                // Transfer the reserved slot from "starting" to "live" without
                // ever counting the same worker in both collections.
                this.startingWorkers -= 1;
                startingSlotReserved = false;
                this.workers.push(worker);
                this.idle.push(worker);
                this.drain();
            } catch (error) {
                startError = error;
            } finally {
                if (startingSlotReserved) this.startingWorkers -= 1;
                if (startPromise) this.workerStarts.delete(startPromise);

                if (
                    startError &&
                    !this.destroying &&
                    this.workers.length === 0 &&
                    this.startingWorkers === 0
                ) {
                    const error = startError instanceof Error
                        ? startError
                        : new Error(String(startError));
                    const queued = this.queue.splice(0);
                    for (const task of queued) task.reject(error);
                }

                if (!this.destroying) this.scaleToDemand();
            }
        })();
        this.workerStarts.add(startPromise);
        return true;
    }

    /** Lazily grow only as far as the current outstanding work requires. */
    private scaleToDemand(): void {
        while (this.startWorkerIfNeeded()) {
            // Each successful call reserves its slot synchronously.
        }
    }

    // 把队列里的任务分发给空闲 worker
    private drain() {
        while (this.idle.length > 0 && this.queue.length > 0) {
            const worker = this.idle.pop()!;
            const task = this.queue.shift()!;
            this.runningTasks.set(worker, task);
            worker.postMessage({ absolutePath: task.absolutePath, relativePath: task.relativePath, lang: task.lang });
        }
    }

    // 外部调用这个提交任务
    parse(absolutePath: string, relativePath: string, lang: string): Promise<FileNode> {
        return new Promise((resolve, reject) => {
            if (this.destroying) {
                reject(new Error('ParserWorkerPool destroyed'));
                return;
            }
            this.queue.push({ absolutePath, relativePath, lang, resolve, reject });
            this.peakOutstandingTasks = Math.max(
                this.peakOutstandingTasks,
                this.queue.length + this.runningTasks.size
            );
            this.drain();
            this.scaleToDemand();
        });
    }

    async destroy() {
        this.destroying = true;
        const pendingError = new Error('ParserWorkerPool destroyed');
        for (const task of this.queue) task.reject(pendingError);
        for (const task of this.runningTasks.values()) task.reject(pendingError);
        this.queue = [];
        this.runningTasks.clear();
        const terminations = this.workers.map(w => w.terminate());
        await Promise.allSettled([...terminations, ...this.workerStarts]);
        this.workers = [];
        this.idle = [];
        this.maxWorkers = 0;
    }
}
