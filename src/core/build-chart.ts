// .memoryanchor/core/build-chart.ts
import * as fs from 'fs';
import * as path from 'path';
import { batchParseFiles } from './chartBuildHelper/ASTParser.js';
export { destroyPool } from './chartBuildHelper/ASTParser.js';
import { ANCHOR_DIR, PROJECT_ROOT, CHART_PATH, logToUser, isIgnored, listProjectFiles } from './chartBuildHelper/utils.js';
import { buildSkeletonSection } from './chartBuildHelper/skeletonEditor.js';
import { 
    buildNodesSection, parseNodeBlocksToMap, classifyChangedFiles, 
    applyParsedResults, persistChart, parseChangedFiles, 
    serializeNodes, applyDeletions
} from './chartBuildHelper/nodesEditor.js';

async function buildChartContent(dirGroups: Map<string, string[]>): Promise<string> {
    const skeletonSection = buildSkeletonSection(dirGroups);
    // Flatten for batch parse, but preserve skeleton ordering (dirs alpha, files alpha)
    const sortedDirs = [...dirGroups.keys()].sort((a, b) => a.localeCompare(b));
    const allFiles: string[] = [];
    for (const dir of sortedDirs) {
        const files = [...dirGroups.get(dir)!].sort();
        allFiles.push(...files);
    }

    // Batch parse all files through worker pool (multithreaded)
    const absFiles = allFiles.map(rel => ({
        absolutePath: path.join(PROJECT_ROOT, rel),
        relativePath: rel
    }));
    const fileNodes = await batchParseFiles(absFiles);
    const nodesSection = buildNodesSection(fileNodes);

    return `# PROJECT CHART\n\n${skeletonSection}\n\n${nodesSection}`;
}

function ensureAnchorDirExists(): void {
    if (!fs.existsSync(ANCHOR_DIR)) {
        fs.mkdirSync(ANCHOR_DIR, { recursive: true });
    }
}

function writeChart(content: string): void {
    fs.writeFileSync(CHART_PATH, content, 'utf-8');
}

// =============================================================================
// Incremental Chart Update
// =============================================================================

interface IncrementalState {
    skeleton: string;
    nodes: string;
    registry: Record<string, any>;
    registryPath: string;
}

/** Load chart.md and registry.json. Returns null if chart is malformed. */
function loadIncrementalState(): IncrementalState | null {
    const chartContent = fs.readFileSync(CHART_PATH, 'utf-8');
    const sectionHeader = '## 2. Key Architecture Nodes';
    const sectionSplit = chartContent.indexOf(sectionHeader);
    if (sectionSplit < 0) return null;

    const registryPath = path.join(ANCHOR_DIR, 'registry.json');
    const registry = fs.existsSync(registryPath)
        ? JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
        : {};

    return {
        skeleton: chartContent.substring(0, sectionSplit).trimEnd(),
        nodes: chartContent.substring(sectionSplit).trimStart(),
        registry,
        registryPath,
    };
}

/**
 * Update chart.md and registry.json for only the files that changed.
 * Falls back to full rebuild if chart.md is malformed.
 */
export async function updateChartIncrementally(changedFiles: string[]): Promise<void> {
    const files = changedFiles.filter((f) => !isIgnored(f));
    if (files.length === 0) return;

    const state = loadIncrementalState();
    if (!state) {
        await buildChartFull();
        return;
    }

    let { skeleton, nodes, registry, registryPath } = state;
    const nodeMap = parseNodeBlocksToMap(nodes);

    const { toDelete, toParse } = classifyChangedFiles(files, registry);

    const delResult = applyDeletions(toDelete, nodeMap, skeleton, registry);
    skeleton = delResult.skeleton;

    const parsedResults = await parseChangedFiles(toParse);
    const parseApplyResult = applyParsedResults(parsedResults, nodeMap, skeleton, registry);
    skeleton = parseApplyResult.skeleton;

    const changed = delResult.changed || parseApplyResult.changed;
    if (!changed) return;

    const newNodes = serializeNodes(skeleton, nodeMap);
    persistChart(skeleton, newNodes, registry, registryPath);
}

// async, must await
export async function buildChartFull(): Promise<void> {
    logToUser("Compiling repository architecture into LLM-Native Chart...", "36");

    try {
        const dirGroups = listProjectFiles();
        const chartContent = await buildChartContent(dirGroups);
        ensureAnchorDirExists();
        writeChart(chartContent);
        logToUser(`Chart successfully compiled and rendered to: .memoryanchor/chart.md`, "32");
    } catch (error: any) {
        process.stderr.write(`\x1b[31m[Memory Anchor Error] Build failed: ${error?.message || error}\x1b[0m\n`);
        throw error;
    }
}
