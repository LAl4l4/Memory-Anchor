import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileNode, ParseRequest } from '../shared/CBHTypes.js';
import { LazyWorkerPool } from '../shared/lazyWorkerPool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'parserWorker.js');

/** Parser-specific facade over the shared lazy worker lifecycle. */
export class ParserWorkerPool {
    private readonly pool = new LazyWorkerPool<ParseRequest, FileNode>({
        createWorker: () => new Worker(WORKER_PATH),
        getResult: message => message.fileNode as FileNode,
        getError: message => new Error(`Parse failed for ${message.file}: ${message.error}`),
    });

    async init(size: number): Promise<void> {
        await this.pool.init(size);
    }

    get activeWorkerCount(): number {
        return this.pool.activeWorkerCount;
    }

    get peakOutstandingTaskCount(): number {
        return this.pool.peakOutstandingTaskCount;
    }

    parse(absolutePath: string, relativePath: string, lang: string): Promise<FileNode> {
        return this.pool.submit({ absolutePath, relativePath, lang });
    }

    async destroy(): Promise<void> {
        await this.pool.destroy();
    }
}
