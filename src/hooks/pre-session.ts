#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { SessionStartResponse } from './types.js';


const cwd = process.cwd(); // 用户运行命令的目录
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const CHART_PATH = path.join(ANCHOR_PATH, 'chart.md');
const BALLAST_PATH = path.join(ANCHOR_PATH, 'ballast.md');
const MANIFEST_PATH = path.join(ANCHOR_PATH, 'manifest.md');

function loadMemory(): string {
    let chart = "No project chart found. Run 'npx memory-anchor build' to generate.";
    if (fs.existsSync(CHART_PATH)) {
        chart = fs.readFileSync(CHART_PATH, 'utf-8').trim();
    }

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

        // 💡 优化点 2：主干逻辑只负责总起，绝不自我嵌套
        return `
    ==================================================
    [MEMORY ANCHOR: CONTEXT INJECTED]
    System Status: Active.
    Target: Assist the developer by ensuring all generated code aligns with local repository constraints.

    ${taskSection}

    [1. PROJECT CHART]
    ${chart}

    [2. BALLAST RULES]
    ${ballastStr}

    [3. MISSION MANIFEST]
    ${manifest}
    ==================================================
    `;
}

function main(): void {
    try {
        const injectedPrompt = loadMemory();
        
        const payload: SessionStartResponse = {
            additionalContext: injectedPrompt
        };
        
        // Output the clean JSON protocol to stdout
        process.stdout.write(JSON.stringify(payload));
    } catch (err) {
        const fallback: SessionStartResponse = { additionalContext: "" };
        process.stdout.write(JSON.stringify(fallback));
    }
    process.exit(0);
}

main();