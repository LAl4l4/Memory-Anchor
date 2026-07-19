import * as fs from 'node:fs';
import {
    applyDeletions,
    applyParsedResults,
    classifyChangedFiles,
    parseChangedFiles,
    parseNodeBlocksToMap,
    serializeNodes,
} from './nodesEditor.js';
import { getSkeletonFileOrder } from './skeletonEditor.js';

export interface PartitionChartUpdateResult {
    changed: boolean;
    previousChars: number;
    currentChars: number;
}

/** Incrementally edit one partition chart; registry data is reconstructed in memory. */
export async function updatePartitionChartContent(
    chartPath: string,
    projectRoot: string,
    changedFiles: string[]
): Promise<PartitionChartUpdateResult> {
    const previousContent = fs.readFileSync(chartPath, 'utf-8');
    const sectionHeader = '## 2. Key Architecture Nodes';
    const sectionSplit = previousContent.indexOf(sectionHeader);
    if (sectionSplit < 0) {
        throw new Error(`Malformed partition chart: ${chartPath}`);
    }

    let skeleton = previousContent.substring(0, sectionSplit).trimEnd();
    const nodes = previousContent.substring(sectionSplit).trimStart();
    const nodeMap = parseNodeBlocksToMap(nodes);
    const registry: Record<string, any> = {};
    for (const file of getSkeletonFileOrder(skeleton)) {
        registry[file.replace(/^\//, '')] = {};
    }

    const { toDelete, toParse } = classifyChangedFiles(
        changedFiles,
        registry,
        projectRoot
    );
    const deleteResult = applyDeletions(toDelete, nodeMap, skeleton, registry);
    skeleton = deleteResult.skeleton;

    const parsed = await parseChangedFiles(toParse);
    const parseResult = applyParsedResults(parsed, nodeMap, skeleton, registry);
    skeleton = parseResult.skeleton;

    const changed = deleteResult.changed || parseResult.changed;
    if (!changed) {
        return {
            changed: false,
            previousChars: previousContent.length,
            currentChars: previousContent.length,
        };
    }

    const newNodes = serializeNodes(skeleton, nodeMap);
    const currentContent = `${skeleton}\n\n${newNodes}`;
    fs.writeFileSync(chartPath, currentContent, 'utf-8');
    return {
        changed: true,
        previousChars: previousContent.length,
        currentChars: currentContent.length,
    };
}
