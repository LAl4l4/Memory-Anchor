#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';
import { buildChartFull } from '../../core/build-chart.js';

const cwd = process.cwd(); // 用户运行命令的目录
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const CHART_PATH = path.join(ANCHOR_PATH, 'chart.md');
const BALLAST_PATH = path.join(ANCHOR_PATH, 'ballast.md');
const MANIFEST_PATH = path.join(ANCHOR_PATH, 'manifest.md');
void CHART_PATH; // make the linter silent about unused variables
/**
 * Helper to write colorized logs directly to stderr
 */
function logToUser(message: string, colorCode: string = '36'): void {
    process.stderr.write(`\x1b[${colorCode}m[Memory Anchor] ${message}\x1b[0m\n`);
}

/**
 * Core Logic 1: Append local git changes to manifest.md Done List
 */
function updateManifest(changes: GitChange[] | null): void {
    if (!fs.existsSync(MANIFEST_PATH) || !changes || changes.length === 0) return;

    let content = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    
    let incrementDone = `\n- [x] **[${timestamp} Session Captured]** AI triggered code changes in:`;
    changes.forEach((c: GitChange) => {
        const statusMap: Record<string, string> = { 'M': 'Modified', 'A': 'Added', '??': 'Untracked' };
        const action = statusMap[c.status] || 'Changed';
        incrementDone += ` \`${c.file}\` (${action});`;
    });

    const targetHeaders = [
        '## Done:',
        '## ✅ 已完成事项 (Done List)'
    ];
    const targetHeader = targetHeaders.find((header) => content.includes(header));
    if (targetHeader) {
        content = content.replace(targetHeader, `${targetHeader}${incrementDone}`);
        fs.writeFileSync(MANIFEST_PATH, content, 'utf-8');
        
        // 🚀 Explicitly writing to stderr, zero ambiguity
        logToUser("Local code changes captured. Mission Manifest updated.", "36");
    }
}

/**
 * Core Logic 2: Flag potential obsolete rules in ballast.md
 */
function cleanBallastRules(changes: GitChange[] | null): void {
    if (!fs.existsSync(BALLAST_PATH) || !changes || changes.length === 0) return;

    let ballastContent = fs.readFileSync(BALLAST_PATH, 'utf-8');
    let hasChanged = false;

    changes.forEach((c: GitChange) => {
        const fileKeyword = path.basename(c.file);
        const escapedKeyword = fileKeyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const ruleRegex = new RegExp(`(- \\[ \\].*${escapedKeyword}.*)`, 'g');

        if (ruleRegex.test(ballastContent)) {
            ballastContent = ballastContent.replace(ruleRegex, (match) => {
                hasChanged = true;
                if (match.includes('[STALE]')) return match; 
                return `${match} [STALE] *(File changed in previous session. Verify if this rule is obsolete)*`;
            });
        }
    });

    if (hasChanged) {
        fs.writeFileSync(BALLAST_PATH, ballastContent, 'utf-8');
        
        // 🚀 Explicitly writing to stderr, zero ambiguity
        logToUser("Ballast scanned. Potential obsolete rules marked with [STALE].", "35");
    }
}

function sanitizeBallast(): void {

    if (!fs.existsSync(BALLAST_PATH)) return;

    const content =
        fs.readFileSync(
            BALLAST_PATH,
            "utf8"
        );

    const rules = content
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {

            // remove AI explanations
            if (
                line.startsWith("Note:") ||
                line.startsWith("Explanation:") ||
                line.startsWith("Rule:")
            ) {
                return null;
            }

            // normalize
            line = line
                .replace(/^\*/, "-")
                .replace(/^\d+\./, "-")
                .replace(/^\[\]/, "- [ ]")
                .replace(/^-?\s*\[\]/, "- [ ]");

            if (
                !/^- \[[ x]\]/.test(line)
            ) {
                line = `- [ ] ${line}`;
            }

            return line;

        })
        .filter(Boolean);

    const unique =
        [...new Set(rules)];

    fs.writeFileSync(
        BALLAST_PATH,
        unique.join("\n"),
        "utf8"
    );

    logToUser(
        `Ballast normalized (${unique.length} rules)`,
        "35"
    );
}

async function main(): Promise<void> {
    const changes = captureGitChanges();
    if (changes && changes.length > 0) {
        updateManifest(changes);
        cleanBallastRules(changes);
        sanitizeBallast();
    }

    await buildChartFull();  // Run full chart rebuild to ensure the sequence of files

    process.exit(0);
}

main();