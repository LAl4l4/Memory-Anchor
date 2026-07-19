import * as path from 'path';
import { globSync } from 'glob';
import { EXT_TO_LANGUAGE } from '../../utils/ext-to-lang.js';
import { IGNORED_DIR_NAMES, IGNORED_FILE_NAMES } from '../../constant.js';

export interface WorkspacePaths {
    anchorDir: string;
    projectRoot: string;
    chartPath: string;
}

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

export function isIgnored(relPath: string): boolean {
    const normalized = relPath.split(path.sep).join('/');
    const segments = normalized.split('/');
    for (const segment of segments) {
        if (IGNORED_DIR_NAMES.has(segment)) return true;
    }
    return IGNORED_FILE_NAMES.has(segments[segments.length - 1]);
}

export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function listProjectFiles(projectRoot: string = PROJECT_ROOT): Map<string, string[]> {
    const allFiles = globSync('**/*', {
        cwd: projectRoot,
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
