import * as fs from 'node:fs';
import * as path from 'path';
import { globSync } from 'glob';
import { EXT_TO_LANGUAGE } from '../../utils/ext-to-lang.js';
import { appendDebugLog } from '../../utils/logger.js';
import { IGNORED_DIR_NAMES, IGNORED_FILE_NAMES } from '../../constant.js';
import { IgnorePolicy } from '../../utils/ignorePolicy.js';
import type { WorkspacePaths } from './CBHTypes.js';

export function resolveWorkspacePaths(): WorkspacePaths {
    const projectRoot = process.cwd();
    const anchorDir = path.join(projectRoot, '.memoryanchor');

    return {
        anchorDir,
        projectRoot,
        chartPath: path.join(anchorDir, 'chart.md')
    };
}

const { anchorDir: ANCHOR_DIR, projectRoot: PROJECT_ROOT, chartPath: CHART_PATH } =
    resolveWorkspacePaths();

export { ANCHOR_DIR, PROJECT_ROOT, CHART_PATH };

export const IGNORE_PATTERNS: string[] = [
    ...[...IGNORED_DIR_NAMES].map(dir => `**/${dir}/**`),
    ...IGNORED_FILE_NAMES,
];

export function logToUser(message: string, colorCode: string = '32'): void {
    process.stderr.write(`\x1b[${colorCode}m[Memory Anchor] ${message}\x1b[0m\n`);
    appendDebugLog(
        colorCode === '31' ? 'error' : colorCode === '33' ? 'warn' : 'info',
        `[Memory Anchor] ${message}`
    );
}

export function getSemanticHint(filePath: string): string {
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

export function isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath);
    return ext in EXT_TO_LANGUAGE;
}

export function isIgnored(relPath: string, projectRoot = process.cwd()): boolean {
    return new IgnorePolicy(projectRoot).isIgnored(relPath);
}

export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function listProjectFiles(
    projectRoot: string = PROJECT_ROOT,
    recursive = true,
    workspaceRoot: string = projectRoot,
    policy = new IgnorePolicy(workspaceRoot)
): Map<string, string[]> {
    const allFiles = globSync(recursive ? '**/*' : '*', {
        cwd: projectRoot,
        nodir: true,
        ignore: {
            ignored: entry => policy.isIgnored(entry.fullpath(), entry.isDirectory()),
            childrenIgnored: entry => policy.isIgnored(entry.fullpath(), true),
        }
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

/** Return absolute paths for every repository file supported by a parser. */
export function listParseableProjectFiles(projectRoot: string = PROJECT_ROOT): string[] {
    return [...listProjectFiles(projectRoot).values()]
        .flat()
        .filter(isCodeFile)
        .map(file => path.resolve(projectRoot, file));
}

/** Check direct file ownership without paying for a glob traversal. */
export function hasDirectProjectFiles(directory: string, workspaceRoot = directory): boolean {
    const policy = new IgnorePolicy(workspaceRoot);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
    }

    return entries.some(entry => {
        if (policy.isIgnored(path.join(directory, entry.name))) return false;
        if (entry.isFile()) return true;
        if (!entry.isSymbolicLink()) return false;

        try {
            return fs.statSync(path.join(directory, entry.name)).isFile();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
        }
    });
}
