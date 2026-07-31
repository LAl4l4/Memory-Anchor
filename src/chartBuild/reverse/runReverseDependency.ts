import * as path from 'node:path';
import { buildGlobalDependencyRegistry } from './dependencyRegistryPool.js';
import { WORKER_THREAD_POOL_SIZE } from '../parse/ASTParser.js';
import type { ChartParseCache, GlobalDependencyRegistry } from '../shared/CBHTypes.js';
import { logToUser } from '../shared/utils.js';

export interface ReverseDependencyStageOptions {
    projectRoot: string;
    parseCache: ChartParseCache;
    dependencyFiles: string[];
    dependencyPaths: ReadonlySet<string>;
}

/**
 * Stage 2: build the one immutable project-wide reverse-call registry from the
 * shared parse cache. Chart workers later apply the subset relevant to each chart.
 */
export async function runReverseDependency(
    options: ReverseDependencyStageOptions
): Promise<GlobalDependencyRegistry> {
    logToUser('Indexing project-wide reverse dependencies...', '36');
    return buildGlobalDependencyRegistry(
        options.dependencyFiles.map(file => ({
            ...options.parseCache.get(file)!,
            relativePath: path.relative(options.projectRoot, file).split(path.sep).join('/'),
        })),
        options.dependencyPaths,
        WORKER_THREAD_POOL_SIZE
    );
}
