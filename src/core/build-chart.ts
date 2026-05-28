// .memoryanchor/core/build-chart.ts
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

import { fileURLToPath } from 'url';

// 当前文件路径
const __filename = fileURLToPath(import.meta.url);
// 当前目录
const __dirname = path.dirname(__filename);

const IGNORE_PATTERNS = [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '.memoryanchor/**',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    '.DS_Store'
];

interface WorkspacePaths {
    anchorDir: string;
    projectRoot: string;
    chartPath: string;
}

/**
 * 🛠️ Path Resolution Strategy
 * Use resolveWorkspacePaths() to ensure that even if the developer triggers the build 
 * command from a deep sub-directory, we always lock onto the exact root.
 */
function resolveWorkspacePaths(): WorkspacePaths {
    let currentDir = process.cwd();
    while (currentDir !== path.dirname(currentDir)) {
        const potentialAnchor = path.join(currentDir, '.memoryanchor');
        if (fs.existsSync(potentialAnchor) && fs.statSync(potentialAnchor).isDirectory()) {
            return {
                anchorDir: potentialAnchor,
                projectRoot: path.dirname(potentialAnchor),
                chartPath: path.join(potentialAnchor, 'chart.md')
            };
        }
        currentDir = path.dirname(currentDir);
    }
    // Fallback to script location parent directory
    const anchorDir = path.resolve(__dirname, '../');
    return {
        anchorDir,
        projectRoot: path.dirname(anchorDir),
        chartPath: path.join(anchorDir, 'chart.md')
    };
}

const { anchorDir: ANCHOR_DIR, projectRoot: PROJECT_ROOT, chartPath: CHART_PATH } =
    resolveWorkspacePaths();

interface FileNode {
    relativePath: string;
    exports: string[];
}

/**
 * Helper to write colorized status logs directly to stderr.
 * This guarantees zero pollution to stdout and ensures standard logs are always visible.
 */
function logToUser(message: string, colorCode: string = '32'): void {
    process.stderr.write(`\x1b[${colorCode}m[Memory Anchor] ${message}\x1b[0m\n`);
}

/**
 * Step 1: Parse JS/TS files using Babel AST to extract structural exports.
 * This skips all conversation, syntax noise, and granular code lines, providing high-density context.
 */
function parseFileArchitecture(absolutePath: string, relativePath: string): FileNode {
    const fileNode: FileNode = { relativePath, exports: [] };
    const ext = path.extname(absolutePath);
    
    if (!['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
        return fileNode;
    }

    try {
        const code = fs.readFileSync(absolutePath, 'utf-8');
        const ast = parse(code, {
            sourceType: 'module',
            plugins: ['typescript', 'jsx']
        });

        traverse(ast, {
            ExportNamedDeclaration(nodePath) {
                const declaration = nodePath.node.declaration;
                if (!declaration) return;

                // Case A: export function myFunc() {}
                if (declaration.type === 'FunctionDeclaration' && declaration.id) {
                    fileNode.exports.push(`Function: \`${declaration.id.name}()\``);
                }
                // Case B: export class MyClass {}
                if (declaration.type === 'ClassDeclaration' && declaration.id) {
                    fileNode.exports.push(`Class: \`${declaration.id.name}\``);
                }
                // Case C: export const myVar = ...
                if (declaration.type === 'VariableDeclaration') {
                    declaration.declarations.forEach(dec => {
                        if (dec.id.type === 'Identifier') {
                            fileNode.exports.push(`Variable/Constant: \`${dec.id.name}\``);
                        }
                    });
                }
            },
            ExportDefaultDeclaration(nodePath) {
                const declaration = nodePath.node.declaration;
                if (declaration && 'id' in declaration && declaration.id) {
                    fileNode.exports.push(`Default Export: \`${declaration.id.name}\``);
                } else {
                    fileNode.exports.push(`Default Export (Anonymous)`);
                }
            }
        });
    } catch (e) {
        // Fallback gracefully on parsing warnings (e.g., incomplete code during active development)
        fileNode.exports.push(`(Module structure parsed as text node due to active refactoring)`);
    }

    return fileNode;
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

function buildNodesSection(files: string[]): string {
    let nodesSection = "## 2. Key Architecture Nodes\n";
    files.forEach(relPath => {
        const absPath = path.join(PROJECT_ROOT, relPath);
        const fileNode = parseFileArchitecture(absPath, relPath);

        if (fileNode.exports.length > 0) {
            nodesSection += `### /${fileNode.relativePath}\n`;
            fileNode.exports.forEach(exp => {
                nodesSection += `- ${exp}\n`;
            });
            nodesSection += '\n';
        }
    });
    return nodesSection;
}

function buildChartContent(files: string[]): string {
    const skeletonSection = buildSkeletonSection(files);
    const nodesSection = buildNodesSection(files);
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
export function updateChartIncrementally(changedFiles: string[]): void {
    const registryPath = path.join(ANCHOR_DIR, 'registry.json');
    let registry = fs.existsSync(registryPath) 
        ? JSON.parse(fs.readFileSync(registryPath, 'utf-8')) 
        : {};

    let chartContent = fs.readFileSync(CHART_PATH, 'utf-8');
    let hasUpdated = false;

    changedFiles.forEach(file => {
        const absPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(absPath)) {
            // 文件被删除了：从 Chart 中彻底移除该块
            chartContent = chartContent.replace(new RegExp(`### /${file}[\\s\\S]*?(?=### /|$)`), '');
            delete registry[file];
            hasUpdated = true;
            return;
        }

        const stats = fs.statSync(absPath);
        // 如果时间没变，跳过
        if (registry[file] && registry[file].mtime === stats.mtimeMs) return;

        // 仅对改动文件调用高耗能的 AST 解析
        const node = parseFileArchitecture(absPath, file);
        const newNodeContent = node.exports.map(e => `- ${e}`).join('\n');
        
        // 更新注册表
        registry[file] = { mtime: stats.mtimeMs, content: newNodeContent };
        
        // 关键：在 chart.md 中原地替换
        const nodeBlock = `### /${file}\n${newNodeContent}\n`;
        const blockRegex = new RegExp(`### /${file}[\\s\\S]*?(?=### /|$)`);
        
        if (blockRegex.test(chartContent)) {
            chartContent = chartContent.replace(blockRegex, nodeBlock);
        } else {
            chartContent += `\n${nodeBlock}`;
        }
        hasUpdated = true;
    });

    if (hasUpdated) {
        fs.writeFileSync(CHART_PATH, chartContent, 'utf-8');
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    }
}

export function buildChartFull(): void {
    logToUser("Compiling repository architecture into LLM-Native Chart...", "36");

    try {
        const allFiles = listProjectFiles();
        const chartContent = buildChartContent(allFiles);
        ensureAnchorDirExists();
        writeChart(chartContent);
        logToUser(`Chart successfully compiled and rendered to: .memoryanchor/chart.md`, "32");
    } catch (error: any) {
        process.stderr.write(`\x1b[31m[Memory Anchor Error] Build failed: ${error?.message || error}\x1b[0m\n`);
        throw error;
    }
}