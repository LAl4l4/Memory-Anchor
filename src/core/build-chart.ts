// .memoryanchor/core/build-chart.ts
import * as fs from 'fs';
import * as path from 'path';
import { parseFileArchitecture, formatSymbol } from './chartBuildHelper/ASTParser.js';
import { ANCHOR_DIR, PROJECT_ROOT, CHART_PATH, logToUser, isIgnored, listProjectFiles, escapeRegex } from './chartBuildHelper/utils.js';
import { buildSkeletonSection, getSkeletonFileOrder, addFileToSkeleton, removeFileFromSkeleton } from './chartBuildHelper/skeletonEditor.js';
import { buildNodesSection, removeNodeBlock, replaceNodeBlock, insertNodeBlock } from './chartBuildHelper/nodesEditor.js';

async function buildChartContent(dirGroups: Map<string, string[]>): Promise<string> {
    const skeletonSection = buildSkeletonSection(dirGroups);
    // Flatten for buildNodesSection, but preserve skeleton ordering (dirs alpha, files alpha)
    const sortedDirs = [...dirGroups.keys()].sort((a, b) => a.localeCompare(b));
    const allFiles: string[] = [];
    for (const dir of sortedDirs) {
        const files = [...dirGroups.get(dir)!].sort();
        allFiles.push(...files);
    }
    const nodesSection = await buildNodesSection(allFiles);
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

// 增量逻辑核心：同时更新 Part 1 (Directory Skeleton) 和 Part 2 (Key Architecture Nodes)
export async function updateChartIncrementally(changedFiles: string[]): Promise<void> {
    const files = changedFiles.filter((f) => !isIgnored(f));
    if (files.length === 0) return;

    const registryPath = path.join(ANCHOR_DIR, 'registry.json');
    let registry = fs.existsSync(registryPath)
        ? JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
        : {};

    let chartContent = fs.readFileSync(CHART_PATH, 'utf-8');

    // Split into skeleton + nodes sections
    const sectionHeader = '## 2. Key Architecture Nodes';
    const sectionSplit = chartContent.indexOf(sectionHeader);
    if (sectionSplit < 0) {
        // Malformed chart -- fall back to full rebuild
        await buildChartFull();
        return;
    }

    let skeletonSection = chartContent.substring(0, sectionSplit).trimEnd();
    let nodesSection = chartContent.substring(sectionSplit).trimStart();
    let hasUpdated = false;

    for (const file of files) {
        const absPath = path.join(PROJECT_ROOT, file);

        if (!fs.existsSync(absPath)) {
            // File deleted -- remove from both sections
            skeletonSection = removeFileFromSkeleton(skeletonSection, file);
            nodesSection = removeNodeBlock(nodesSection, file);
            delete registry[file];
            hasUpdated = true;
            continue;
        }

        const stats = fs.statSync(absPath);
        if (registry[file] && registry[file].mtime === stats.mtimeMs) continue;

        const escapedFile = escapeRegex(file);
        const hasExistingBlock = new RegExp(`### /${escapedFile}\\n`).test(nodesSection);

        // Only add skeleton entry for brand-new files (not already tracked)
        if (!hasExistingBlock) {
            skeletonSection = addFileToSkeleton(skeletonSection, file);
        }

        // Parse architecture (expensive)
        const node = await parseFileArchitecture(absPath, file);
        const newNodeContent = node.symbols.map(formatSymbol).join('\n');

        if (!newNodeContent) {
            if (hasExistingBlock) {
                nodesSection = removeNodeBlock(nodesSection, file);
                skeletonSection = removeFileFromSkeleton(skeletonSection, file);
                delete registry[file];
                hasUpdated = true;
            }
            continue;
        }

        registry[file] = { mtime: stats.mtimeMs, content: newNodeContent };

        if (hasExistingBlock) {
            nodesSection = replaceNodeBlock(nodesSection, file, newNodeContent);
        } else {
            // Use skeleton order to determine correct insertion position
            const skeletonOrder = getSkeletonFileOrder(skeletonSection);
            nodesSection = insertNodeBlock(nodesSection, skeletonOrder, file, newNodeContent);
        }
        hasUpdated = true;
    }

    if (hasUpdated) {
        chartContent = skeletonSection + '\n\n' + nodesSection;
        fs.writeFileSync(CHART_PATH, chartContent, 'utf-8');
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
