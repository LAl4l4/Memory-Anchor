import * as path from 'path';
import os from "os";
import { ParserWorkerPool } from './parserPool.js';
import { getAvailableParsers } from '../parser-loader.js';
import { EXT_TO_LANGUAGE } from '../../utils/ext-to-lang.js';
import { FileSymbol, FileNode } from './symbolExtractor.js';

// Re-export types for backward compatibility
export type { FileSymbol, FileNode };

// The max amount of worker threads
const THREAD_POOL_SIZE = Math.max(2, os.cpus().length - 1);

let pool: ParserWorkerPool | null = null;

export async function ensureParserInit() {
    if (!pool) {
        pool = new ParserWorkerPool();
        await pool.init(THREAD_POOL_SIZE);
    }
}

export async function destroyPool() {
    if (pool) {
        await pool.destroy();
        pool = null;
    }
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

    // Ensure pool is initialized
    await ensureParserInit();

    const availableParsers = getAvailableParsers();

    const tasks: Promise<FileNode>[] = files.map(({ absolutePath, relativePath }) => {
        const ext = path.extname(absolutePath);
        const lang = EXT_TO_LANGUAGE[ext];

        if (!lang || !availableParsers.has(lang)) {
            return Promise.resolve({ relativePath, language: '', symbols: [] });
        }

        return pool!.parse(absolutePath, relativePath, lang);
    });

    return Promise.all(tasks);
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
