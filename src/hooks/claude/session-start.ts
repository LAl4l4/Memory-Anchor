#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

const cwd = process.cwd();
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const CHART_PATH = path.join(ANCHOR_PATH, 'chart.md');
const BALLAST_PATH = path.join(ANCHOR_PATH, 'ballast.md');
const MANIFEST_PATH = path.join(ANCHOR_PATH, 'manifest.md');

void CHART_PATH; // make the linter silent about unused variables

function loadMemory(): string {

    let ballastStr = "No active coding constraints or lessons-learned enforced.";
    if (fs.existsSync(BALLAST_PATH)) {
        ballastStr = fs.readFileSync(BALLAST_PATH, 'utf-8').trim();
    }

    let manifest = "No active cross-session tasks found.";
    if (fs.existsSync(MANIFEST_PATH)) {
        manifest = fs.readFileSync(MANIFEST_PATH, 'utf-8').trim();
    }

    const hasStaleRules = ballastStr.includes('[STALE]');
    let taskSection = '';
    if (hasStaleRules) {
        taskSection = `
            [TRIGGERED MISSION: MEMORY PRUNING]
            - Urgent Status: Some developer-enforced limits inside the [2. BALLAST RULES] section are currently flagged with '[STALE]'.
            - Your Action Required: These rules are likely obsolete due to recent code changes. You MUST evaluate and directly rewrite '.memoryanchor/ballast.md' to DELETE any invalid stale rules during this session.
            `;
    }

    return `
==================================================
[MEMORY ANCHOR: CONTEXT INJECTED]
System Status: Active.
Target: Assist the developer by ensuring all generated code aligns with local repository constraints.

${taskSection}

[1. BALLAST RULES]
${ballastStr}

[2. MISSION MANIFEST]
${manifest}
==================================================
    `;
}

function main(): void {
    // claude 不需要特殊的json，直接输出文本即可
    try {
        const injectedPrompt = loadMemory();
        process.stdout.write(injectedPrompt);
    } catch (err) {
        process.stdout.write("Failed to load memory.");
    }
    process.exit(0);
}

main();
