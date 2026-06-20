import { Worker } from 'worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'parserWorker.js');

interface Task {
    absolutePath: string;
    relativePath: string;
    lang: string;
    resolve: (result: any) => void;
    reject: (err: any) => void;
}

export class ParserWorkerPool {
    private workers: Worker[] = [];
    private queue: Task[] = [];
    private idle: Worker[] = [];
    private runningTasks = new Map<Worker, Task>();

    async init(size: number) {
        // 并行启动所有 worker，等全部 init 完成
        this.workers = await Promise.all(
            Array.from({ length: size }, () => this.createWorker())
        );
        this.idle = [...this.workers]; // 刚启动全部空闲
    }

    private createWorker(): Promise<Worker> {
        return new Promise((resolve, reject) => {
            const worker = new Worker(WORKER_PATH);

            // worker 发来 ready 信号说明 Parser.init() 完成了
            worker.once('message', (msg) => {
                if (msg.type === 'ready') resolve(worker);
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
                } else {
                    reject(err); // 仍在 init 阶段
                }
                // worker 已经挂了，不应该再放回 idle —— 见下一点
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    const task = this.runningTasks.get(worker);
                    if (task) {
                        this.runningTasks.delete(worker);
                        task.reject(new Error(`Worker exited with code ${code}`));
                    }
                }
            });
        });
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
    parse(absolutePath: string, relativePath: string, lang: string): Promise<any> {
        return new Promise((resolve, reject) => {
            this.queue.push({ absolutePath, relativePath, lang, resolve, reject });
            this.drain();
        });
    }

    async destroy() {
        const pendingError = new Error('ParserWorkerPool destroyed');
        for (const task of this.queue) task.reject(pendingError);
        for (const task of this.runningTasks.values()) task.reject(pendingError);
        this.queue = [];
        this.runningTasks.clear();
        await Promise.all(this.workers.map(w => w.terminate()));
    }
}