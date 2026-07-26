import * as path from 'path';
import { getResolvedDependencyPaths } from './dependencyGraph.js';
import { FileNode } from './symbolExtractor.js';
import { escapeRegex } from './utils.js';

/**
 * Generate directory-grouped file skeleton from pre-built dir-to-files mapping.
 * - Root-level files (.) are listed directly without a heading.
 * - Subdirectories get a ### heading and list their basenames with in-chart dependencies.
 * - Directories are listed recursively — each directory containing files gets its own section.
 */
function formatDependencySuffix(fileNode: FileNode | undefined): string {
    const dependencies = fileNode ? getResolvedDependencyPaths(fileNode) : [];
    return dependencies.length > 0 ? ` -> ${dependencies.join('; ')}` : '';
}

export function generateTreeSkeleton(
    dirGroups: Map<string, string[]>,
    fileNodes: readonly FileNode[] = []
): string {
    // Sort directories depth-first (parent before children, then alphabetically)
    const sortedDirs = [...dirGroups.keys()].sort((a, b) => a.localeCompare(b));

    const nodesByPath = new Map(fileNodes.map(fileNode => [fileNode.relativePath, fileNode]));
    let skeletonStr = "";

    for (const dir of sortedDirs) {
        const dirFiles = dirGroups.get(dir)!.sort();

        if (dir === '.') {
            // Root-level files — no heading, use full path
            for (const file of dirFiles) {
                skeletonStr += `- /${file}${formatDependencySuffix(nodesByPath.get(file))}\n`;
            }
            if (dirFiles.length > 0) {
                skeletonStr += '\n';
            }
        } else {
            skeletonStr += `### ${dir}/\n`;
            for (const file of dirFiles) {
                const base = path.basename(file);
                skeletonStr += `- ${base}${formatDependencySuffix(nodesByPath.get(file))}\n`;
            }
            skeletonStr += '\n';
        }
    }

    return skeletonStr.trimEnd();
}

export function buildSkeletonSection(
    dirGroups: Map<string, string[]>,
    fileNodes: readonly FileNode[] = []
): string {
    let skeletonSection = "## 1. Directory Skeleton\n";
    skeletonSection += generateTreeSkeleton(dirGroups, fileNodes);
    return skeletonSection;
}

/**
 * Parse the Directory Skeleton section to produce an ordered list of file paths
 * (e.g. ["/AGENTS.md", "/src/index.ts", "/src/cli.ts", ...]).
 * This ordering is the canonical reference for Key Nodes ordering.
 */
export function getSkeletonFileOrder(skeletonSection: string): string[] {
    const order: string[] = [];
    const lines = skeletonSection.split('\n');
    let currentDir = '';

    for (const line of lines) {
        const dirMatch = line.match(/^### (.+)\/$/);
        if (dirMatch) {
            currentDir = dirMatch[1];
            continue;
        }

        // Root files: "- /filename -> dependency"; directory files follow
        // the same shape without the leading slash.
        const fileMatch = line.match(/^- ([^\s]+)(?: -> .*)?$/);
        if (fileMatch) {
            const name = fileMatch[1];
            if (name.startsWith('/')) {
                order.push(name);
            } else {
                order.push(`/${currentDir}/${name}`);
            }
        }
    }
    return order;
}

/** Add a single file entry into the skeleton section, preserving alphabetical order. */
export function addFileToSkeleton(skeletonSection: string, file: string): string {
    const dir = path.dirname(file);
    const base = path.basename(file);

    if (dir === '.') {
        // Root-level file
        const rootLine = `- /${base}`;
        const lines = skeletonSection.split('\n');
        const titleIndex = lines.findIndex(l => l.startsWith('## 1. Directory Skeleton'));
        let insertIndex = titleIndex + 1;
        while (insertIndex < lines.length && lines[insertIndex].trim() === '') insertIndex++;
        while (
            insertIndex < lines.length &&
            (lines[insertIndex].startsWith('- /') || lines[insertIndex].trim() === '') &&
            lines[insertIndex].startsWith('- /') &&
            lines[insertIndex].localeCompare(rootLine) < 0
        ) {
            insertIndex++;
        }
        lines.splice(insertIndex, 0, rootLine);
        return lines.join('\n');
    }

    // File under a directory
    const newLine = `- ${base}`;
    const sectionRegex = new RegExp(`### ${escapeRegex(dir)}/\\n((?:- [^\\n]*\\n)*)`, 'g');
    const sectionMatch = sectionRegex.exec(skeletonSection);

    if (sectionMatch) {
        const existingLines = sectionMatch[1].split('\n').filter(l => l.trim());
        const allLines = [...existingLines, newLine].sort();
        const newSection = `### ${dir}/\n${allLines.join('\n')}\n`;
        return skeletonSection.replace(sectionMatch[0], newSection);
    }

    // New directory -- insert ### dir/ heading at alphabetical position, then at end if not found
    return insertNewDirSection(skeletonSection, dir, [newLine]);
}

/** Create a new `### dir/` heading inside the skeleton and insert at the
 *  correct alphabetical position among existing directory headings. */
export function insertNewDirSection(skeletonSection: string, dir: string, fileLines: string[]): string {
    const lines = skeletonSection.split('\n');
    const newHeading = `### ${dir}/`;

    let inserted = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('### ') && lines[i].endsWith('/')) {
            if (lines[i].localeCompare(newHeading) > 0) {
                // Insert before this section (with a blank line separator)
                let insertIdx = i;
                while (insertIdx > 0 && lines[insertIdx - 1].trim() !== '') insertIdx--;
                if (insertIdx > 0 && lines[insertIdx - 1].trim() !== '') {
                    lines.splice(insertIdx, 0, '', newHeading, ...fileLines);
                } else {
                    lines.splice(insertIdx, 0, newHeading, ...fileLines);
                }
                inserted = true;
                break;
            }
        }
    }

    if (!inserted) {
        // Append at end (before ## 2. Key Architecture Nodes)
        const nodesIdx = lines.findIndex(l => l.startsWith('## 2.'));
        const insertIdx = nodesIdx >= 0 ? nodesIdx : lines.length;
        lines.splice(insertIdx, 0, '', newHeading, ...fileLines);
    }

    return lines.join('\n');
}

/** Remove a file entry from the skeleton.  If the parent directory section
 *  becomes empty after removal, remove the section heading as well. */
export function removeFileFromSkeleton(skeletonSection: string, file: string): string {
    const dir = path.dirname(file);
    const base = path.basename(file);

    if (dir === '.') {
        const escapedFile = escapeRegex(`/${base}`);
        const lineRegex = new RegExp(`^- ${escapedFile}(?: -> [^\\n]*)?\\n?`, 'gm');
        return skeletonSection.replace(lineRegex, '');
    }

    const escapedDir = escapeRegex(dir);
    const sectionRegex = new RegExp(`(### ${escapedDir}/\\n)((?:- [^\\n]*\\n)*)`, 'g');
    const sectionMatch = sectionRegex.exec(skeletonSection);
    if (!sectionMatch) return skeletonSection;

    const remainingLines = sectionMatch[2].split('\n').filter(
        l => l.trim() && !l.trim().startsWith(`- ${base}`)
    );

    if (remainingLines.length === 0) {
        // Remove entire section heading
        return skeletonSection.replace(
            new RegExp(`\\n?### ${escapedDir}/\\n(?:- [^\\n]*\\n)*`, 'g'),
            ''
        );
    }

    const newSection = `### ${dir}/\n${remainingLines.join('\n')}\n`;
    return skeletonSection.replace(sectionMatch[0], newSection);
}
