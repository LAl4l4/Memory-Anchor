import * as path from 'path';
import { parseFileArchitecture, formatSymbol } from './ASTParser.js';
import { escapeRegex, PROJECT_ROOT } from './utils.js';

export async function buildNodesSection(files: string[]): Promise<string> {
    let nodesSection = "## 2. Key Architecture Nodes\n";
    for (const relPath of files) {
        const absPath = path.join(PROJECT_ROOT, relPath);
        const fileNode = await parseFileArchitecture(absPath, relPath);

        const validSymbols = fileNode.symbols.filter(
            exp => exp.type !== 'error'
        );

        if (validSymbols.length > 0) {
            nodesSection += `### /${fileNode.relativePath}\n`;
            validSymbols.forEach((exp) => {
                nodesSection += `${formatSymbol(exp)}\n`;
            });
            nodesSection += '\n';
        }
    }
    return nodesSection;
}

/** Remove a key-node block for a file from the nodes section. */
export function removeNodeBlock(nodesSection: string, file: string): string {
    const escapedFile = escapeRegex(file);
    return nodesSection.replace(
        new RegExp(`### /${escapedFile}\\n(?:- [^\\n]*\\n?)*`, 'g'),
        ''
    );
}

/** Replace the key-node block for a file in-place. */
export function replaceNodeBlock(nodesSection: string, file: string, newNodeContent: string): string {
    const escapedFile = escapeRegex(file);
    const blockRegex = new RegExp(`### /${escapedFile}\\n(?:- [^\\n]*\\n?)*`, 'g');
    return nodesSection.replace(blockRegex, `### /${file}\n${newNodeContent}`);
}

/** Insert a new key-node block at the position dictated by the skeleton file order. */
export function insertNodeBlock(
  nodesSection: string,
  skeletonOrder: string[],
  file: string,
  newNodeContent: string
): string {
    const normalizedPath = '/' + file;
    const nodeBlock = `### /${file}\n${newNodeContent}`;

    // Collect existing blocks (preserving order)
    const blockRegex = /(### \/[^\n]+\n(?:- [^\n]*\n?)*)/g;
    const blocks: { path: string; text: string }[] = [];
    let match;
    while ((match = blockRegex.exec(nodesSection)) !== null) {
        const pathMatch = match[1].match(/^### (\/[^\n]+)/);
        if (pathMatch) {
            blocks.push({ path: pathMatch[1], text: match[1] });
        }
    }

    // Use hash map for O(1) lookup of skeleton order index
    // Reduce full algorithm complexity from O(n^2) to O(n) by avoiding nested loops for insertion point
    const rank = new Map<string, number>(
        skeletonOrder.map((p, i) => [p, i])
    );

    // Find insertion position
    const newPathIndex = rank.get(normalizedPath)
    if (newPathIndex === undefined) {
        throw new Error(
            `[Memory Anchor] insertNodeBlock: '${normalizedPath}' missing from skeleton order. ` +
            `This is a bug — addFileToSkeleton and getSkeletonFileOrder have mismatched path formats.` +
            `Please arise this issue to https://github.com/LAl4l4/Memory-Anchor`
        );
    }
    let insertIdx = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
        const existingIdx = rank.get(blocks[i].path)
        if (existingIdx === undefined) {
            throw new Error(
                `[Memory Anchor] Orphan node block detected for '${blocks[i].path}'. ` +
                `chart.md is in an inconsistent state. Please run 'anchor init' to rebuild.`
            );
        }
        if (existingIdx > newPathIndex) {
            insertIdx = i;
            break;
        }
    }

    blocks.splice(insertIdx, 0, { path: normalizedPath, text: nodeBlock });

    return '## 2. Key Architecture Nodes\n' + blocks.map(b => b.text).join('\n\n') + '\n';
}
