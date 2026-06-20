// .memoryanchor/core/build-chart.ts
import * as fs from 'fs';
import * as path from 'path';
import { parseFileArchitecture, formatSymbol, batchParseFiles } from './chartBuildHelper/ASTParser.js';
export { destroyPool } from './chartBuildHelper/ASTParser.js';
import { ANCHOR_DIR, PROJECT_ROOT, CHART_PATH, logToUser, isIgnored, listProjectFiles, escapeRegex } from './chartBuildHelper/utils.js';
import { buildSkeletonSection, getSkeletonFileOrder, addFileToSkeleton, removeFileFromSkeleton } from './chartBuildHelper/skeletonEditor.js';
import { buildNodesSection, removeNodeBlock, replaceNodeBlock, insertNodeBlock } from './chartBuildHelper/nodesEditor.js';

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

interface FileResult {
    skeleton: string;
    nodes: string;
    updated: boolean;
}

/**
 * Parse a modified or new file, then update skeleton, nodes, and registry.
 * Assumes the caller has already verified the file exists and mtime has changed.
 */
async function handleModifiedFile(
    file: string,
    absPath: string,
    stats: fs.Stats,
    skeleton: string,
    nodes: string,
    registry: Record<string, any>
): Promise<FileResult> {
    const escapedFile = escapeRegex(file);
    const hasExistingBlock = new RegExp(`### /${escapedFile}\\n`).test(nodes);

    let newSkeleton = skeleton;
    if (!hasExistingBlock) {
        newSkeleton = addFileToSkeleton(newSkeleton, file);
    }

    const node = await parseFileArchitecture(absPath, file);
    const newNodeContent = node.symbols.map(formatSymbol).join('\n');

    if (!newNodeContent) {
        // Parsed but no symbols: if it was tracked, remove it
        if (hasExistingBlock) {
            newSkeleton = removeFileFromSkeleton(newSkeleton, file);
            delete registry[file];
            return { skeleton: newSkeleton, nodes: removeNodeBlock(nodes, file), updated: true };
        }
        return { skeleton: newSkeleton, nodes, updated: false };
    }

    registry[file] = { mtime: stats.mtimeMs, content: newNodeContent };

    let newNodes: string;
    if (hasExistingBlock) {
        newNodes = replaceNodeBlock(nodes, file, newNodeContent);
    } else {
        const skeletonOrder = getSkeletonFileOrder(newSkeleton);
        newNodes = insertNodeBlock(nodes, skeletonOrder, file, newNodeContent);
    }

    return { skeleton: newSkeleton, nodes: newNodes, updated: true };
}

/** Dispatch one changed file: delete, skip, or delegate to handleModifiedFile. */
async function processChangedFile(
    file: string,
    skeleton: string,
    nodes: string,
    registry: Record<string, any>
): Promise<FileResult> {
    const absPath = path.join(PROJECT_ROOT, file);

    // --- File deleted ---
    if (!fs.existsSync(absPath)) {
        const newSkeleton = removeFileFromSkeleton(skeleton, file);
        const newNodes = removeNodeBlock(nodes, file);
        delete registry[file];
        return { skeleton: newSkeleton, nodes: newNodes, updated: true };
    }

    // --- File unchanged (mtime match) ---
    const stats = fs.statSync(absPath);
    if (registry[file] && registry[file].mtime === stats.mtimeMs) {
        return { skeleton, nodes, updated: false };
    }

    // --- File new or modified ---
    return handleModifiedFile(file, absPath, stats, skeleton, nodes, registry);
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
    let hasUpdated = false;

    for (const file of files) {
        const result = await processChangedFile(file, skeleton, nodes, registry);
        if (result.updated) hasUpdated = true;
        skeleton = result.skeleton;
        nodes = result.nodes;
    }

    if (hasUpdated) {
        fs.writeFileSync(CHART_PATH, skeleton + '\n\n' + nodes, 'utf-8');
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    }
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
