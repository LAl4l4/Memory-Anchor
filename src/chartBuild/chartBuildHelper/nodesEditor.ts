import * as fs from 'fs';
import * as path from 'path';
import { formatSymbol, batchParseFiles } from './ASTParser.js';
import { getResolvedDependencyPaths } from './dependencyGraph.js';
import { FileNode } from './symbolExtractor.js';
import { CHART_PATH, PROJECT_ROOT } from './utils.js';
import { getSkeletonFileOrder, addFileToSkeleton, removeFileFromSkeleton } from './skeletonEditor.js';

/**
 * Build the Nodes section from pre-parsed FileNode results.
 * Pure formatting — no file I/O or parsing.
 */
export function buildNodesSection(fileNodes: FileNode[]): string {
    let nodesSection = "## 2. Key Architecture Nodes\n";
    for (const fileNode of fileNodes) {
        const validSymbols = fileNode.symbols.filter(
            exp => exp.type !== 'error'
        );

        const dependencies = getResolvedDependencyPaths(fileNode);
        const dependencySuffix = dependencies.length > 0 ? ` -> ${dependencies.join('; ')}` : '';
        nodesSection += `### /${fileNode.relativePath}${dependencySuffix}\n`;
        if (validSymbols.length > 0) {
            validSymbols.forEach((exp) => {
                nodesSection += `${formatSymbol(exp)}\n`;
            });
        }
        nodesSection += '\n';
    }
    return nodesSection;
}

// =============================================================================
// Step 1: 分类 —— 判断每个变更文件属于 删除 / 跳过 / 待重新parse
// =============================================================================

interface ClassifiedFiles {
    toDelete: string[];
    toParse: { file: string; absPath: string; stats: fs.Stats }[];
}

export function classifyChangedFiles(
    files: string[],
    registry: Record<string, any>,
    projectRoot: string = PROJECT_ROOT
): ClassifiedFiles {
    const toDelete: string[] = [];
    const toParse: { file: string; absPath: string; stats: fs.Stats }[] = [];

    for (const file of files) {
        const absPath = path.join(projectRoot, file);
        if (!fs.existsSync(absPath)) {
            toDelete.push(file);
            continue;
        }
        const stats = fs.statSync(absPath);
        if (registry[file]?.mtime === stats.mtimeMs) continue; // 未变
        toParse.push({ file, absPath, stats });
    }

    return { toDelete, toParse };
}

// =============================================================================
// Step 2: 解析 nodes 字符串为 Map,只做一次
// =============================================================================

export function parseNodeBlocksToMap(nodesSection: string): Map<string, string> {
    const blockRegex = /### (\/[^\n]+?)(?: -> [^\n]+)?\n((?:[+-] [^\n]*\n?)*)/g;
    const map = new Map<string, string>();
    let match;
    while ((match = blockRegex.exec(nodesSection)) !== null) {
        const [, filePath, body] = match;
        map.set(filePath, `### ${filePath}\n${body}`.trimEnd());
    }
    return map;
}

// =============================================================================
// Step 3: 应用删除 —— 修改 nodeMap / skeleton / registry,返回是否有变化
// =============================================================================

export function applyDeletions(
    toDelete: string[],
    nodeMap: Map<string, string>,
    skeleton: string,
    registry: Record<string, any>
): { skeleton: string; changed: boolean } {
    let changed = false;
    for (const file of toDelete) {
        const normalizedPath = '/' + file;
        const hadNode = nodeMap.delete(normalizedPath);
        const hadRegistry = file in registry;
        if (hadNode || hadRegistry) {
            skeleton = removeFileFromSkeleton(skeleton, file); // 不再被 nodeMap 是否存在这个条件卡住
            delete registry[file];
            changed = true;
        }
    }
    return { skeleton, changed };
}

// =============================================================================
// Step 4: 批量 parse 新增/修改文件 —— 纯 IO/CPU,不碰 skeleton/nodeMap/registry
// =============================================================================

interface ParsedFileResult {
    file: string;
    stats: fs.Stats;
    newNodeContent: string; // 可能为空字符串(无 symbol)
}

export async function parseChangedFiles(
    toParse: { file: string; absPath: string; stats: fs.Stats }[]
): Promise<ParsedFileResult[]> {
    if (toParse.length === 0) return [];

    const parsedNodes = await batchParseFiles(
        toParse.map(({ file, absPath }) => ({ absolutePath: absPath, relativePath: file }))
    );

    return toParse.map(({ file, stats }, i) => ({
        file,
        stats,
        newNodeContent: parsedNodes[i].symbols.map(formatSymbol).join('\n'),
    }));
}

// =============================================================================
// Step 5: 应用 parse 结果 —— 修改 nodeMap / skeleton / registry,返回是否有变化
// =============================================================================

export function applyParsedResults(
    results: ParsedFileResult[],
    nodeMap: Map<string, string>,
    skeleton: string,
    registry: Record<string, any>
): { skeleton: string; changed: boolean } {
    let changed = false;

    for (const { file, stats, newNodeContent } of results) {
        const normalizedPath = '/' + file;
        const hasExistingBlock = nodeMap.has(normalizedPath);
        const hasRegistryEntry = file in registry;

        if (!newNodeContent) {
            // A symbol-free file still belongs in the directory skeleton.
            if (hasExistingBlock) {
                nodeMap.delete(normalizedPath);
            }
            if (!hasRegistryEntry) skeleton = addFileToSkeleton(skeleton, file);
            registry[file] = { mtime: stats.mtimeMs, content: '' };
            changed = true;
            continue;
        }

        if (!hasExistingBlock) {
            skeleton = addFileToSkeleton(skeleton, file);
        }
        nodeMap.set(normalizedPath, `### ${normalizedPath}\n${newNodeContent}`);
        registry[file] = { mtime: stats.mtimeMs, content: newNodeContent };
        changed = true;
    }

    return { skeleton, changed };
}

// =============================================================================
// Step 6: 序列化 —— 按 skeleton 顺序把 nodeMap 拼成最终 nodes 字符串
// =============================================================================

export function serializeNodes(skeleton: string, nodeMap: Map<string, string>): string {
    const skeletonOrder = getSkeletonFileOrder(skeleton);
    const skeletonSet = new Set(skeletonOrder);
    const orderedBlocks: string[] = [];

    for (const p of skeletonOrder) {
        const block = nodeMap.get(p);
        if (block) orderedBlocks.push(block);
        // 没有 block 是正常情况,跳过
    }

    for (const p of nodeMap.keys()) {
        if (!skeletonSet.has(p)) {
            console.warn(`[Memory Anchor] Dropping orphan node block for '${p}' (not in skeleton). Consider running 'anchor init' if this persists.`);
        }
    }

    return '## 2. Key Architecture Nodes\n' + orderedBlocks.join('\n\n') + '\n';
}

// =============================================================================
// Step 7: 落盘 —— 唯一做 fs.writeFileSync 的地方
// =============================================================================

export function persistChart(
    skeleton: string,
    nodes: string,
    registry: Record<string, any>,
    registryPath: string
): void {
    fs.writeFileSync(CHART_PATH, skeleton + '\n\n' + nodes, 'utf-8');
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}
