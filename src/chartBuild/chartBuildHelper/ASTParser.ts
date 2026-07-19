import * as path from 'path';
import os from "os";
import { ParserWorkerPool } from './parserPool.js';
import { getAvailableParsers } from '../parser-loader.js';
import { EXT_TO_LANGUAGE } from '../../utils/ext-to-lang.js';
import { FileSymbol, FileNode } from './symbolExtractor.js';

// Re-export types for backward compatibility
export type { FileSymbol, FileNode };

// The max amount of worker threads
const availableParallelism = os.availableParallelism?.() ?? os.cpus().length;
const THREAD_POOL_SIZE = Math.max(2, availableParallelism - 1);

let pool: ParserWorkerPool | null = null;
let poolInitPromise: Promise<void> | null = null;

export async function ensureParserInit() {
    if (poolInitPromise) return poolInitPromise;
    if (pool) return;

    const nextPool = new ParserWorkerPool();
    pool = nextPool;
    const initPromise = nextPool.init(THREAD_POOL_SIZE);
    poolInitPromise = initPromise;

    try {
        await initPromise;
    } catch (error) {
        if (pool === nextPool) pool = null;
        throw error;
    } finally {
        if (poolInitPromise === initPromise) poolInitPromise = null;
    }
}

export async function destroyPool() {
    const currentPool = pool;
    pool = null;
    poolInitPromise = null;
    if (currentPool) await currentPool.destroy();
}

export async function parseFileArchitecture(
    absolutePath: string,
    relativePath: string
): Promise<FileNode> {

    const ext = path.extname(absolutePath);
    const lang = EXT_TO_LANGUAGE[ext];

    if (!lang) {
        return { relativePath, language: '', symbols: [] };
    }

    const availableParsers = getAvailableParsers();
    if (!availableParsers.has(lang)) {
        return { relativePath, language: '', symbols: [] };
    }

    // Ensure pool is initialized
    await ensureParserInit();

    try {
        const fileNode = await pool!.parse(absolutePath, relativePath, lang);
        return fileNode;
    } catch (err) {
        console.error(err);
        return {
            relativePath,
            language: lang,
            symbols: [{ type: "error", name: String(err) }]
        };
    }
}

/**
 * Batch parse multiple files through the worker pool.
 * Files that have no available parser are returned as empty FileNodes without going to the pool.
 */
export async function batchParseFiles(
    files: { absolutePath: string; relativePath: string }[]
): Promise<FileNode[]> {
    if (files.length === 0) return [];

    const availableParsers = getAvailableParsers();
    const results: FileNode[] = files.map(({ absolutePath, relativePath }) => {
        const ext = path.extname(absolutePath);
        const lang = EXT_TO_LANGUAGE[ext];
        return {
            relativePath,
            language: lang && availableParsers.has(lang) ? lang : '',
            symbols: [],
        };
    });

    const supportedFiles = files
        .map((file, index) => ({ ...file, index }))
        .filter(({ absolutePath }) => {
            const lang = EXT_TO_LANGUAGE[path.extname(absolutePath)];
            return Boolean(lang && availableParsers.has(lang));
        });

    // Avoid starting even one worker when the batch contains no parseable files.
    if (supportedFiles.length === 0) return results;

    await ensureParserInit();

    // Submit the entire batch immediately. ParserWorkerPool owns scheduling and
    // lazily creates no more than its configured CPU-bound worker maximum.
    await Promise.all(supportedFiles.map(async ({ absolutePath, relativePath, index }) => {
        const lang = EXT_TO_LANGUAGE[path.extname(absolutePath)];
        results[index] = await pool!.parse(absolutePath, relativePath, lang);
    }));

    return results;
}

export function formatSymbol(exp: FileSymbol): string {
    switch (exp.type) {
        case 'function_declaration':
            return `- function ${exp.name}()`;

        case 'class_declaration':
            return `- class ${exp.name}`;

        case 'interface_declaration':
            return `- interface ${exp.name}`;

        case 'enum_declaration':
            return `- enum ${exp.name}`;

        case 'type_declaration':
            return `- type ${exp.name}`;

        case 'exported_function_declaration':
            return `- export function ${exp.name}()`;

        case 'exported_class_declaration':
            return `- export class ${exp.name}`;

        case 'exported_interface_declaration':
            return `- export interface ${exp.name}`;

        case 'exported_enum_declaration':
            return `- export enum ${exp.name}`;

        case 'exported_type_declaration':
            return `- export type ${exp.name}`;

        default:
            return `- ${exp.name}`;
    }
}
