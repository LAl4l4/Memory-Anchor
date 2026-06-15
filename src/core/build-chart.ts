// .memoryanchor/core/build-chart.ts
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { Parser } from "web-tree-sitter";
import { loadLanguage, getAvailableParsers } from './parser-loader.js';
import { EXT_TO_LANGUAGE } from '../utils/ext-to-lang.js';
import { IGNORED_DIR_NAMES, IGNORED_FILE_NAMES, JS_EXPORT_LANGS, GENERIC_DECLARATIONS, FUNCTION_DECLARATION_TYPES, CLASS_DECLARATION_TYPES, INTERFACE_DECLARATION_TYPES, ENUM_DECLARATION_TYPES, TYPE_DECLARATION_TYPES } from '../constant.js';

const IGNORE_PATTERNS: string[] = [
    ...[...IGNORED_DIR_NAMES].map(dir => `**/${dir}/**`),
    ...IGNORED_FILE_NAMES,
];

let initialized = false;

export async function ensureParserInit() {
    if (!initialized) {
        await Parser.init();
        initialized = true;
    }
}

interface WorkspacePaths {
    anchorDir: string;
    projectRoot: string;
    chartPath: string;
}


function resolveWorkspacePaths(): WorkspacePaths {

    const projectRoot = process.cwd();

    const anchorDir =
        path.join(projectRoot, '.memoryanchor');

    return {
        anchorDir,
        projectRoot,
        chartPath: path.join(anchorDir, 'chart.md')
    };
}

const { anchorDir: ANCHOR_DIR, projectRoot: PROJECT_ROOT, chartPath: CHART_PATH } =
    resolveWorkspacePaths();

interface FileSymbol {
    type: string;
    name: string;
}

interface FileNode {
    relativePath: string;
    language: string;
    symbols: FileSymbol[];
}

/**
 * Helper to write colorized status logs directly to stderr.
 * This guarantees zero pollution to stdout and ensures standard logs are always visible.
 */
function logToUser(message: string, colorCode: string = '32'): void {
    process.stderr.write(`\x1b[${colorCode}m[Memory Anchor] ${message}\x1b[0m\n`);
}

export async function parseFileArchitecture(
  absolutePath: string,
  relativePath: string
): Promise<FileNode> {

    const fileNode: FileNode = {
        relativePath,
        language: '',
        symbols: []
    };

    const ext = path.extname(absolutePath);
    const lang = EXT_TO_LANGUAGE[ext];

    if (!lang) return fileNode;

    const availableParsers = getAvailableParsers();
    if (!availableParsers.has(lang)) return fileNode;

    try {
        const code = fs.readFileSync(absolutePath, "utf-8");

        await ensureParserInit();
        const parser = new Parser();
        const language = await loadLanguage(lang);
        parser.setLanguage(language);

        const tree = parser.parse(code);

        if (!tree || !tree.rootNode) {
            logToUser(`⚠️ Failed to parse ${relativePath}`, '31');
            return fileNode; // 返回空节点
        }

        fileNode.language = lang;

        extractSymbols(tree.rootNode, fileNode);

    } catch (err) {
        console.error(err);

        fileNode.symbols.push({
            type: "error",
            name: String(err)
        });
    }

    return fileNode;
}

function extractSymbols(node: any, fileNode: FileNode) {
    for (const child of node.children) {
        const symbolInfo = getSymbolInfo(child, fileNode.language);
        if (symbolInfo) {
            fileNode.symbols.push(symbolInfo);
            // 只有当它是一个函数、接口、枚举或类型声明时，才停止深入子节点
            // 类声明我们允许继续深入，因为它可能包含方法定义，我们也想捕获到
            if (!CLASS_DECLARATION_TYPES.has(symbolInfo.type))
            continue;
        }

        extractSymbols(child, fileNode);
    }
}

function getSymbolInfo(node: any, lang: string): FileSymbol | null {
    let isExported = false;

    // 针对 JavaScript/TypeScript 的 export 语法进行特殊处理
    if (JS_EXPORT_LANGS.has(lang) && node.type === "export_statement") {
        const target =
            node.namedChildren.find((c: any) =>
                GENERIC_DECLARATIONS.has(c.type)
            );
        if (!target) return null;
        node = target;
        isExported = true;
    }

    if (!GENERIC_DECLARATIONS.has(node.type)) return null;

    const name = getNodeName(node);
    if (!name) return null;

    // 🔥 核心修复 1：针对 C/C++ 等语言的 struct/enum/union 的特殊防护
    // 只有当它们包含 body（即 field_declaration_list）时，才算作真正的“类型定义”
    if (node.type === "struct_specifier" || node.type === "enum_specifier") {
        // childForFieldName 是 Tree-sitter 的原生方法，用来查找指定名称的子节点
        const hasBody = node.childForFieldName("body") !== null;
        if (!hasBody) return null; // 只是作为参数或变量类型使用，直接过滤掉
    }

    let type: string = node.type;
    if (FUNCTION_DECLARATION_TYPES.has(node.type)) {
        type = 'function_declaration';
    } else if (CLASS_DECLARATION_TYPES.has(node.type)) {
        type = 'class_declaration';
    } else if (INTERFACE_DECLARATION_TYPES.has(node.type)) {
        type = 'interface_declaration';
    } else if (ENUM_DECLARATION_TYPES.has(node.type)) {
        type = 'enum_declaration';
    } else if (TYPE_DECLARATION_TYPES.has(node.type)) {
        type = 'type_declaration';
    }
    
    if (isExported) {
        type = 'exported_' + type;
    }

    return { type, name };

}

function formatSymbol(exp: FileSymbol): string {
    switch (exp.type) {
        case 'function_declaration':
            return `- function ${exp.name}()`;

        case 'class_declaration':
            return `- class ${exp.name}`;

        case 'interface_declaration':
            return `- interface ${exp.name}`;

        case 'enum_declaration':
            return `- enum ${exp.name}`;

        case 'type_declaration':
            return `- type ${exp.name}`;

        case 'exported_function_declaration':
            return `- export function ${exp.name}()`;

        case 'exported_class_declaration':
            return `- export class ${exp.name}`;

        case 'exported_interface_declaration':
            return `- export interface ${exp.name}`;

        case 'exported_enum_declaration':
            return `- export enum ${exp.name}`;

        case 'exported_type_declaration':
            return `- export type ${exp.name}`;

        default:
            return `- ${exp.name}`;
    }
}

function getNodeName(node: any): string | null {
    const nameNode = node.childForFieldName?.("name");
    if (nameNode?.text) return nameNode.text;

    const identifier = findIdentifier(node);
    return identifier?.text ?? null;
}

function findIdentifier(node: any): any | null {
    if (!node?.namedChildren) return null;

    for (const child of node.namedChildren) {
        if (
            child.type === "identifier" ||
            child.type === "type_identifier" ||
            child.type === "field_identifier"
        ) {
            return child;
        }
    }

    for (const child of node.namedChildren) {
        const found = findIdentifier(child);
        if (found) return found;
    }

    return null;
}

/**
 * Step 2: Generate LLM-Native Flat Path Skeleton (Zero ASCII Noise)
 * Replaces hard-to-read tree lines with flat paths optimized for LLM attention weights.
 */
function getSemanticHint(filePath: string): string {
    const ext = path.extname(filePath);
    const base = path.basename(filePath);

    if (base === 'package.json') return "Project manifest, dependency definitions, and entry scripts.";
    if (base === 'tsconfig.json') return "TypeScript compiler options and workspace path mappings.";
    if (base.startsWith('index.')) return "Main entry gate and routing aggregator for this directory.";
    if (filePath.includes('router') || filePath.includes('controller') || filePath.includes('api'))
        return "Network interface layer handling endpoints and HTTP contracts.";
    if (filePath.includes('service') || filePath.includes('spider') || filePath.includes('scraper'))
        return "Core business logic handler, scrapers, or background data operators.";
    if (filePath.includes('model') || filePath.includes('schema') || filePath.includes('entity'))
        return "Data persistence layer, types, or database architecture blueprints.";
    if (filePath.includes('test') || filePath.includes('spec') || filePath.includes('jest'))
        return "Automated test suites and verification scripts.";
    if (ext === '.md') return "Local documentation asset.";

    return "Source code module.";
}

function isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath);
    return ext in EXT_TO_LANGUAGE;
}

/**
 * Generate directory-grouped file skeleton from pre-built dir-to-files mapping.
 * - Root-level files (.) are listed directly without a heading.
 * - Subdirectories with code files get a ### heading and list basenames with hints.
 * - Subdirectories without code files get a ### heading and a generic "resources" note.
 * - Directories are listed recursively — each directory containing files gets its own section.
 */
function generateTreeSkeleton(dirGroups: Map<string, string[]>): string {
    // Sort directories depth-first (parent before children, then alphabetically)
    const sortedDirs = [...dirGroups.keys()].sort((a, b) => a.localeCompare(b));

    let skeletonStr = "";

    for (const dir of sortedDirs) {
        const dirFiles = dirGroups.get(dir)!.sort();

        const hasCodeFile = dirFiles.some((f) => isCodeFile(f));

        if (dir === '.') {
            // Root-level files — no heading, use full path
            for (const file of dirFiles) {
                skeletonStr += `- /${file}: ${getSemanticHint(file)}\n`;
            }
            if (dirFiles.length > 0) {
                skeletonStr += '\n';
            }
        } else if (hasCodeFile) {
            skeletonStr += `### ${dir}/\n`;
            for (const file of dirFiles) {
                const base = path.basename(file);
                skeletonStr += `- ${base}: ${getSemanticHint(file)}\n`;
            }
            skeletonStr += '\n';
        } else {
            // Directory has files but none are code files
            skeletonStr += `### ${dir}/\n`;
            skeletonStr += `- This is resources directory\n\n`;
        }
    }

    return skeletonStr.trimEnd();
}

function isIgnored(relPath: string): boolean {
    const normalized = relPath.split(path.sep).join('/');
    const segments = normalized.split('/');
    for (const segment of segments) {
        if (IGNORED_DIR_NAMES.has(segment)) return true;
    }
    return IGNORED_FILE_NAMES.has(segments[segments.length - 1]);
}

function listProjectFiles(): Map<string, string[]> {
    const allFiles = globSync('**/*', {
        cwd: PROJECT_ROOT,
        nodir: true,
        ignore: IGNORE_PATTERNS
    });

    const dirGroups = new Map<string, string[]>();
    for (const f of allFiles) {
        const dir = path.dirname(f);
        if (!dirGroups.has(dir)) {
            dirGroups.set(dir, []);
        }
        dirGroups.get(dir)!.push(f);
    }
    return dirGroups;
}

function buildSkeletonSection(dirGroups: Map<string, string[]>): string {
    let skeletonSection = "## 1. Directory Skeleton\n";
    skeletonSection += generateTreeSkeleton(dirGroups);
    return skeletonSection;
}

async function buildNodesSection(files: string[]): Promise<string> {
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

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse the Directory Skeleton section to produce an ordered list of file paths
 * (e.g. ["/AGENTS.md", "/src/index.ts", "/src/cli.ts", ...]).
 * This ordering is the canonical reference for Key Nodes ordering.
 */
function getSkeletonFileOrder(skeletonSection: string): string[] {
    const order: string[] = [];
    const lines = skeletonSection.split('\n');
    let currentDir = '';

    for (const line of lines) {
        const dirMatch = line.match(/^### (.+)\/$/);
        if (dirMatch) {
            currentDir = dirMatch[1];
            continue;
        }

        // Root files: "- /filename: ..."   Dir files: "- basename: ..."
        const fileMatch = line.match(/^- ([^\s:]+):/);
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
function addFileToSkeleton(skeletonSection: string, file: string): string {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const hint = getSemanticHint(file);

    if (dir === '.') {
        // Root-level file
        const rootLine = `- /${base}: ${hint}`;
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
    const newLine = `- ${base}: ${hint}`;
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
function insertNewDirSection(skeletonSection: string, dir: string, fileLines: string[]): string {
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
function removeFileFromSkeleton(skeletonSection: string, file: string): string {
    const dir = path.dirname(file);
    const base = path.basename(file);

    if (dir === '.') {
        const escapedFile = escapeRegex(`/${base}`);
        const lineRegex = new RegExp(`^- ${escapedFile}: [^\\n]*\\n?`, 'g');
        return skeletonSection.replace(lineRegex, '');
    }

    const escapedDir = escapeRegex(dir);
    const sectionRegex = new RegExp(`(### ${escapedDir}/\\n)((?:- [^\\n]*\\n)*)`, 'g');
    const sectionMatch = sectionRegex.exec(skeletonSection);
    if (!sectionMatch) return skeletonSection;

    const remainingLines = sectionMatch[1].split('\n').filter(
        l => l.trim() && !l.trim().startsWith(`- ${base}:`)
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

/** Remove a key-node block for a file from the nodes section. */
function removeNodeBlock(nodesSection: string, file: string): string {
    const escapedFile = escapeRegex(file);
    return nodesSection.replace(
        new RegExp(`### /${escapedFile}\\n(?:- [^\\n]*\\n?)*`, 'g'),
        ''
    );
}

/** Replace the key-node block for a file in-place. */
function replaceNodeBlock(nodesSection: string, file: string, newNodeContent: string): string {
    const escapedFile = escapeRegex(file);
    const blockRegex = new RegExp(`### /${escapedFile}\\n(?:- [^\\n]*\\n?)*`, 'g');
    return nodesSection.replace(blockRegex, `### /${file}\n${newNodeContent}`);
}

/** Insert a new key-node block at the position dictated by the skeleton file order. */
function insertNodeBlock(
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

    // Find insertion position
    const newPathIndex = skeletonOrder.indexOf(normalizedPath);
    let insertIdx = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
        const existingIdx = skeletonOrder.indexOf(blocks[i].path);
        if (existingIdx > newPathIndex) {
            insertIdx = i;
            break;
        }
    }

    blocks.splice(insertIdx, 0, { path: normalizedPath, text: nodeBlock });

    return '## 2. Key Architecture Nodes\n' + blocks.map(b => b.text).join('\n\n') + '\n';
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
