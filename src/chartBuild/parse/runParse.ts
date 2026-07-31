import * as path from 'node:path';
import {
    createDependencyPaths,
    getChartFiles,
    primeChartParseCache,
} from '../render/chartContentBuilder.js';
import type { ChartParseCache } from '../shared/CBHTypes.js';
import { isCodeFile, listProjectFiles, logToUser, resolveWorkspacePaths } from '../shared/utils.js';

export interface ParseStageResult {
    projectRoot: string;
    dirGroups: Map<string, string[]>;
    /** Absolute paths available as forward dependency targets. */
    dependencyFiles: string[];
    dependencyPaths: ReadonlySet<string>;
    parseCache: ChartParseCache;
}

/**
 * Stage 1: enumerate repository files and parse them once into a build-scoped
 * cache. The cache is reused by every later stage so no file is parsed twice.
 */
export async function runParse(
    options: {
        projectRoot?: string;
        parseCache?: ChartParseCache;
        dependencyPaths?: ReadonlySet<string>;
    } = {}
): Promise<ParseStageResult> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const parseCache = options.parseCache ?? new Map();
    const dirGroups = listProjectFiles(projectRoot);
    const dependencyFiles = getChartFiles(dirGroups, projectRoot)
        .filter(({ absolutePath }) => isCodeFile(absolutePath))
        .map(({ absolutePath }) => absolutePath);
    const dependencyPaths = options.dependencyPaths ?? createDependencyPaths(
        dependencyFiles,
        projectRoot
    );

    // One wide batch gives the pool useful parallel work and prevents reparsing
    // the same files once per later stage.
    logToUser(`Parsing ${dependencyFiles.length} source files...`, '36');
    await primeChartParseCache(dirGroups, projectRoot, parseCache);

    return { projectRoot, dirGroups, dependencyFiles, dependencyPaths, parseCache };
}
