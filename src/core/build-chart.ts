// .memoryanchor/core/build-chart.ts
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { Parser } from "web-tree-sitter";
import { loadLanguage, getAvailableParsers } from './parser-loader.js';
import { EXT_TO_LANGUAGE } from '../utils/ext-to-lang.js';
import { IGNORED_DIR_NAMES, IGNORED_FILE_NAMES } from '../constant.js';

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

const JS_EXPORT_LANGS = new Set(["javascript", "typescript", "tsx"]);
const GENERIC_DECLARATIONS = new Set([
    "function_definition",
    "function_declaration",
    "method_definition",
    "method_declaration",
    "class_definition",
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "type_definition",
    "struct_specifier"
]);
const FUNCTION_DECLARATION_TYPES = new Set([
    "function_definition",
    "function_declaration",
    "method_definition",
    "method_declaration"
]);
const CLASS_DECLARATION_TYPES = new Set([
    "class_definition",
    "class_declaration",
]);
const INTERFACE_DECLARATION_TYPES = new Set([
    "interface_declaration"
]);
const ENUM_DECLARATION_TYPES = new Set([
    "enum_declaration"
]);
const TYPE_DECLARATION_TYPES = new Set([
    "record_declaration",
    "type_definition",
    "struct_specifier"
]);

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
function generateTreeSkeleton(files: string[]): string {
    let skeletonStr = "";
    
    files.sort().forEach(f => {
        let semanticHint = "Source code module.";
        const ext = path.extname(f);
        const base = path.basename(f);

        // Rule-based automated directory layer sniffing
        if (base === 'package.json') semanticHint = "Project manifest, dependency definitions, and entry scripts.";
        else if (base === 'tsconfig.json') semanticHint = "TypeScript compiler options and workspace path mappings.";
        else if (base.startsWith('index.')) semanticHint = "Main entry gate and routing aggregator for this directory.";
        else if (f.includes('router') || f.includes('controller') || f.includes('api')) semanticHint = "Network interface layer handling endpoints and HTTP contracts.";
        else if (f.includes('service') || f.includes('spider') || f.includes('scraper')) semanticHint = "Core business logic handler, scrapers, or background data operators.";
        else if (f.includes('model') || f.includes('schema') || f.includes('entity')) semanticHint = "Data persistence layer, types, or database architecture blueprints.";
        else if (f.includes('test') || f.includes('spec') || f.includes('jest')) semanticHint = "Automated test suites and verification scripts.";
        else if (ext === '.md') semanticHint = "Local documentation asset.";

        skeletonStr += `- /${f}: ${semanticHint}\n`;
    });
    
    return skeletonStr;
}

function isIgnored(relPath: string): boolean {
    const normalized = relPath.split(path.sep).join('/');
    const segments = normalized.split('/');
    for (const segment of segments) {
        if (IGNORED_DIR_NAMES.has(segment)) return true;
    }
    return IGNORED_FILE_NAMES.has(segments[segments.length - 1]);
}

function listProjectFiles(): string[] {
    return globSync('**/*', {
        cwd: PROJECT_ROOT,
        nodir: true,
        ignore: IGNORE_PATTERNS
    });
}

function buildSkeletonSection(files: string[]): string {
    let skeletonSection = "## 1. Directory Skeleton\n";
    skeletonSection += generateTreeSkeleton(files);
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

async function buildChartContent(files: string[]): Promise<string> {
    const skeletonSection = buildSkeletonSection(files);
    const nodesSection = await buildNodesSection(files);
    return `# PROJECT CHART\n\n${skeletonSection}\n${nodesSection}`;
}

function ensureAnchorDirExists(): void {
    if (!fs.existsSync(ANCHOR_DIR)) {
        fs.mkdirSync(ANCHOR_DIR, { recursive: true });
    }
}

function writeChart(content: string): void {
    fs.writeFileSync(CHART_PATH, content, 'utf-8');
}

// 增量逻辑核心：只处理给定的文件列表
export async function updateChartIncrementally(changedFiles: string[]): Promise<void> {
    const files = changedFiles.filter((f) => !isIgnored(f));
    if (files.length === 0) return;

    const registryPath = path.join(ANCHOR_DIR, 'registry.json');
    let registry = fs.existsSync(registryPath) 
        ? JSON.parse(fs.readFileSync(registryPath, 'utf-8')) 
        : {};

    let chartContent = fs.readFileSync(CHART_PATH, 'utf-8');
    let hasUpdated = false;

    for (const file of files) {
        const absPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(absPath)) {
            // 文件被删除了：从 Chart 中彻底移除该块
            chartContent = chartContent.replace(new RegExp(`### /${file}[\\s\\S]*?(?=### /|$)`), '');
            delete registry[file];
            hasUpdated = true;
            continue;
        }

        const stats = fs.statSync(absPath);
        // 如果时间没变，跳过
        if (registry[file] && registry[file].mtime === stats.mtimeMs) continue;

        // 仅对改动文件调用高耗能的 AST 解析
        const node = await parseFileArchitecture(absPath, file);
        const newNodeContent = node.symbols.map(formatSymbol).join('\n');
        const blockRegex = new RegExp(`### /${file}[\\s\\S]*?(?=### /|$)`);
        const hasExistingBlock = blockRegex.test(chartContent);

        // 如果解析结果为空，则与buildFull行为保持一致：完全不写入
        if (!newNodeContent) {
            if (hasExistingBlock) {
                // 文件存在但是已无导出 → 移除整块（与存量写入的过滤逻辑一致）
                chartContent = chartContent.replace(blockRegex, '');
                delete registry[file];
                hasUpdated = true;
            }
            // 没有导出且没有旧块 → 什么都不做
            continue;
        }

        // 更新注册表
        registry[file] = { mtime: stats.mtimeMs, content: newNodeContent };

        // 关键：在 chart.md 中原地替换
        const nodeBlock = `### /${file}\n${newNodeContent}\n`;

        if (hasExistingBlock) {
            chartContent = chartContent.replace(blockRegex, nodeBlock);
        } else {
            chartContent += `\n${nodeBlock}`;
        }
        hasUpdated = true;
    }

    if (hasUpdated) {
        fs.writeFileSync(CHART_PATH, chartContent, 'utf-8');
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    }
}

// async, must await
export async function buildChartFull(): Promise<void> {
    logToUser("Compiling repository architecture into LLM-Native Chart...", "36");

    try {
        const allFiles = listProjectFiles();
        const chartContent = await buildChartContent(allFiles);
        ensureAnchorDirExists();
        writeChart(chartContent);
        logToUser(`Chart successfully compiled and rendered to: .memoryanchor/chart.md`, "32");
    } catch (error: any) {
        process.stderr.write(`\x1b[31m[Memory Anchor Error] Build failed: ${error?.message || error}\x1b[0m\n`);
        throw error;
    }
}
