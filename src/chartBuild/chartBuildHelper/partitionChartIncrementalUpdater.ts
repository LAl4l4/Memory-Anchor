import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildNodesSection,
} from './nodesEditor.js';
import { batchParseFiles } from './ASTParser.js';
import { buildChartDependencyGraph } from './dependencyGraph.js';
import { buildSkeletonSection, getSkeletonFileOrder } from './skeletonEditor.js';
import { listParseableProjectFiles } from './utils.js';

export interface PartitionChartUpdateResult {
    changed: boolean;
    previousChars: number;
    currentChars: number;
}

function groupFilesByDirectory(files: readonly string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const file of files) {
        const directory = path.posix.dirname(file);
        const entries = groups.get(directory) ?? [];
        entries.push(file);
        groups.set(directory, entries);
    }
    return groups;
}

/**
 * Refresh one partition chart from its complete in-chart file set. Reverse
 * dependency edges can change in files other than the edited one, so parsing
 * only the changed file would leave the chart graph stale.
 */
export async function updatePartitionChartContent(
    chartPath: string,
    projectRoot: string,
    changedFiles: string[]
): Promise<PartitionChartUpdateResult> {
    const previousContent = fs.readFileSync(chartPath, 'utf-8');
    const skeletonHeader = '## 1. Directory Skeleton';
    const sectionHeader = '## 2. Key Architecture Nodes';
    const skeletonStart = previousContent.indexOf(skeletonHeader);
    const sectionSplit = previousContent.indexOf(sectionHeader);
    if (skeletonStart < 0 || sectionSplit < 0) {
        throw new Error(`Malformed partition chart: ${chartPath}`);
    }

    let skeleton = previousContent.substring(0, sectionSplit).trimEnd();
    const chartHeading = previousContent.substring(0, skeletonStart);
    const childChartsHeader = '\n## 3. Child Charts';
    const childChartsSplit = previousContent.indexOf(childChartsHeader, sectionSplit);
    const childCharts = childChartsSplit < 0
        ? ''
        : previousContent.substring(childChartsSplit).trim();
    const fileSet = new Set(
        getSkeletonFileOrder(skeleton).map(file => file.replace(/^\//, ''))
    );
    for (const file of changedFiles) {
        const absolutePath = path.join(projectRoot, file);
        if (fs.existsSync(absolutePath)) fileSet.add(file);
        else fileSet.delete(file);
    }

    const files = [...fileSet].sort();
    const parsedFiles = await batchParseFiles(files.map(file => ({
        absolutePath: path.join(projectRoot, file),
        relativePath: file,
    })));
    const dependencyPaths = new Set(listParseableProjectFiles(projectRoot).map(file =>
        path.relative(projectRoot, file).split(path.sep).join('/')
    ));
    const fileNodes = buildChartDependencyGraph(parsedFiles, dependencyPaths);
    skeleton = `${chartHeading}${buildSkeletonSection(groupFilesByDirectory(files), fileNodes)}`;
    const newNodes = buildNodesSection(fileNodes);
    const currentContent = childCharts
        ? `${skeleton}\n\n${newNodes.trimEnd()}\n\n${childCharts}\n`
        : `${skeleton}\n\n${newNodes}`;

    if (currentContent === previousContent) {
        return {
            changed: false,
            previousChars: previousContent.length,
            currentChars: previousContent.length,
        };
    }

    fs.writeFileSync(chartPath, currentContent, 'utf-8');
    return {
        changed: true,
        previousChars: previousContent.length,
        currentChars: currentContent.length,
    };
}
