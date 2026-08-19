import * as path from 'path';
import os from "os";
import { ParserWorkerPool } from './parserPool.js';
import { getAvailableParsers } from '../parser-loader.js';
import { EXT_TO_LANGUAGE } from '../../utils/ext-to-lang.js';
import { formatError, logger } from '../../utils/logger.js';
import type { ChartFile, FileNode, FileSymbol } from '../shared/CBHTypes.js';

// Re-export types for backward compatibility
export type { FileSymbol, FileNode } from '../shared/CBHTypes.js';

// The max amount of worker threads
const availableParallelism = os.availableParallelism?.() ?? os.cpus().length;
export const WORKER_THREAD_POOL_SIZE = Math.max(2, availableParallelism - 1);

let pool: ParserWorkerPool | null = null;
let poolInitPromise: Promise<void> | null = null;

export async function ensureParserInit() {
    if (poolInitPromise) return poolInitPromise;
    if (pool) return;

    const nextPool = new ParserWorkerPool();
    pool = nextPool;
    const initPromise = nextPool.init(WORKER_THREAD_POOL_SIZE);
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
        return { relativePath, language: '', symbols: [], dependencies: [] };
    }

    const availableParsers = getAvailableParsers();
    if (!availableParsers.has(lang)) {
        return { relativePath, language: '', symbols: [], dependencies: [] };
    }

    // Ensure pool is initialized
    await ensureParserInit();

    try {
        const fileNode = await pool!.parse(absolutePath, relativePath, lang);
        return fileNode;
    } catch (err) {
        logger.error(formatError(err));
        return {
            relativePath,
            language: lang,
            symbols: [{
                type: "error",
                name: String(err),
                startIndex: 0,
                endIndex: 0,
                startLine: 1,
                endLine: 1,
                forwardDependencies: [],
                dependedOnBy: [],
            }],
            dependencies: [],
        };
    }
}

/**
 * Batch parse multiple files through the worker pool.
 * Files that have no available parser are returned as empty FileNodes without going to the pool.
 */
export async function batchParseFiles(
    files: ChartFile[]
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
            dependencies: [],
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
    let formatted: string;
    const lineRange = `[L${exp.startLine}-${exp.endLine}]`;
    switch (exp.type) {
        case 'function_declaration':
            formatted = `- ${exp.name}() ${lineRange}`;
            break;

        case 'class_declaration':
            formatted = `- class ${exp.name} ${lineRange}`;
            break;

        case 'interface_declaration':
            formatted = `- interface ${exp.name} ${lineRange}`;
            break;

        case 'enum_declaration':
            formatted = `- enum ${exp.name} ${lineRange}`;
            break;

        case 'type_declaration':
            formatted = `- type ${exp.name} ${lineRange}`;
            break;

        case 'exported_function_declaration':
            formatted = `+ ${exp.name}${exp.parameters ?? '()'}${
                exp.returnType ? `: ${exp.returnType}` : ''
            } ${lineRange}`;
            break;

        case 'exported_class_declaration':
            formatted = `+ export class ${exp.name} ${lineRange}`;
            break;

        case 'exported_interface_declaration':
            formatted = `+ export interface ${exp.name} ${lineRange}`;
            break;

        case 'exported_enum_declaration':
            formatted = `+ export enum ${exp.name} ${lineRange}`;
            break;

        case 'exported_type_declaration':
            formatted = `+ export type ${exp.name} ${lineRange}`;
            break;

        default:
            formatted = `- ${exp.name} ${lineRange}`;
    }

    const withReverseDependencies = exp.dependedOnBy.length > 0
        ? `${formatted} <- ${exp.dependedOnBy.join('; ')}`
        : formatted;
    return withReverseDependencies;
}
