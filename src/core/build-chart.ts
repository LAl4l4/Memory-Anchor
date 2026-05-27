// .memory_anchor/core/build-chart.ts
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

/**
 * 🛠️ Path Resolution Strategy
 * Use findAnchorDir() to ensure that even if the developer triggers the build 
 * command from a deep sub-directory, we always lock onto the exact root.
 */
function findAnchorDir(): string {
    let currentDir = process.cwd();
    while (currentDir !== path.dirname(currentDir)) {
        const potentialAnchor = path.join(currentDir, '.memory_anchor');
        if (fs.existsSync(potentialAnchor) && fs.statSync(potentialAnchor).isDirectory()) {
            return potentialAnchor;
        }
        currentDir = path.dirname(currentDir);
    }
    // Fallback to script location parent directory
    return path.resolve(__dirname, '../');
}

const ANCHOR_DIR = findAnchorDir();
const PROJECT_ROOT = path.dirname(ANCHOR_DIR); // The actual project workspace root
const CHART_PATH = path.join(ANCHOR_DIR, 'chart.md');

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

function main(): void {
    logToUser("Compiling repository architecture into LLM-Native Chart...", "36");

    try {
        // Gather all functional source files, ignoring artifacts, locks, and system states
        const allFiles = globSync('**/*', {
            cwd: PROJECT_ROOT,
            nodir: true,
            ignore: [
                'node_modules/**',
                '.git/**',
                'dist/**',
                'build/**',
                '.memory_anchor/**',
                'package-lock.json',
                'pnpm-lock.yaml',
                'yarn.lock',
                '.DS_Store'
            ]
        });

        // 🧱 Structure Part 1: Clean Flat Path Mapping
        let skeletonSection = "## 1. Directory Skeleton\n";
        skeletonSection += generateTreeSkeleton(allFiles);

        // 🧱 Structure Part 2: High-Density AST Signature Blocks
        let nodesSection = "## 2. Key Architecture Nodes\n";
        allFiles.forEach(relPath => {
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

        const finalChartContent = `# PROJECT CHART\n\n${skeletonSection}\n${nodesSection}`;

        // Ensure .memory_anchor directory exists before writing
        if (!fs.existsSync(ANCHOR_DIR)) {
            fs.mkdirSync(ANCHOR_DIR, { recursive: true });
        }

        fs.writeFileSync(CHART_PATH, finalChartContent, 'utf-8');
        logToUser(`Chart successfully compiled and rendered to: .memory_anchor/chart.md`, "32");

    } catch (error: any) {
        process.stderr.write(`\x1b[31m[Memory Anchor Error] Build failed: ${error?.message || error}\x1b[0m\n`);
        process.exit(1);
    }
}

main();