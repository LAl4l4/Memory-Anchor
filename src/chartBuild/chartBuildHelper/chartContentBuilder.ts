import * as path from 'node:path';
import { batchParseFiles } from './ASTParser.js';
import { buildNodesSection } from './nodesEditor.js';
import { buildSkeletonSection } from './skeletonEditor.js';
import { FileNode } from './symbolExtractor.js';
import { PROJECT_ROOT } from './utils.js';

export type ChartParseCache = Map<string, FileNode>;

interface ChartFile {
    absolutePath: string;
    relativePath: string;
}

function getChartFiles(
    dirGroups: Map<string, string[]>,
    projectRoot: string
): ChartFile[] {
    const sortedDirs = [...dirGroups.keys()].sort((a, b) => a.localeCompare(b));
    const files: ChartFile[] = [];

    for (const dir of sortedDirs) {
        for (const relativePath of [...dirGroups.get(dir)!].sort()) {
            files.push({
                absolutePath: path.resolve(projectRoot, relativePath),
                relativePath,
            });
        }
    }

    return files;
}

/** Parse every cache miss in one batch so the lazy worker pool can parallelize it. */
export async function primeChartParseCache(
    dirGroups: Map<string, string[]>,
    projectRoot: string = PROJECT_ROOT,
    parseCache: ChartParseCache = new Map()
): Promise<ChartParseCache> {
    const uniqueMisses = new Map<string, ChartFile>();
    for (const file of getChartFiles(dirGroups, projectRoot)) {
        if (!parseCache.has(file.absolutePath)) uniqueMisses.set(file.absolutePath, file);
    }

    const misses = [...uniqueMisses.values()];
    const parsed = await batchParseFiles(misses);
    misses.forEach((file, index) => parseCache.set(file.absolutePath, parsed[index]));
    return parseCache;
}

/** Build one chart document from an already-grouped set of project files. */
export async function buildChartContent(
    dirGroups: Map<string, string[]>,
    projectRoot: string = PROJECT_ROOT,
    parseCache: ChartParseCache = new Map(),
    chartHeading: string = 'PROJECT CHART'
): Promise<string> {
    const skeletonSection = buildSkeletonSection(dirGroups);
    const chartFiles = getChartFiles(dirGroups, projectRoot);
    await primeChartParseCache(dirGroups, projectRoot, parseCache);
    const fileNodes = chartFiles.map(({ absolutePath, relativePath }) => ({
        ...parseCache.get(absolutePath)!,
        relativePath,
    }));
    const nodesSection = buildNodesSection(fileNodes);

    return `# ${chartHeading}\n\n${skeletonSection}\n\n${nodesSection}`;
}
