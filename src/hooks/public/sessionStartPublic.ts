#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from './hookDebug.js';

const cwd = process.cwd();
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const INDEX_PATH = path.join(ANCHOR_PATH, 'index.md');
const ROOT_CHART_PATH = path.join(ANCHOR_PATH, 'chart', 'chart.md');
const BALLAST_PATH = path.join(ANCHOR_PATH, 'ballast.md');
const MANIFEST_PATH = path.join(ANCHOR_PATH, 'manifest.md');

export function loadMemoryCore(): string {
  const invocation = logHookTriggered(getHookInvocation());
  try {
    let index = 'No project chart available.';
    if (fs.existsSync(INDEX_PATH)) {
      index = fs.readFileSync(INDEX_PATH, 'utf-8').trim();
    }

    let chart = `[INDEX ROUTING RULES — ALWAYS INJECTED]\n${index}`;
    if (fs.existsSync(ROOT_CHART_PATH)) {
      const rootChart = fs.readFileSync(ROOT_CHART_PATH, 'utf-8').trim();
      chart += `\n\n[ROOT CHART ALREADY INJECTED — DO NOT READ IT AGAIN]\n${rootChart}`;
    }

    let ballastStr = 'No active coding constraints or lessons-learned enforced.';
    if (fs.existsSync(BALLAST_PATH)) {
      ballastStr = fs.readFileSync(BALLAST_PATH, 'utf-8').trim();
    }

    let manifest = 'No active cross-session tasks found.';
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

    const memoryCore = `
==================================================
[MEMORY ANCHOR: CONTEXT INJECTED]
Target: Assist the developer by ensuring all generated code aligns with local repository constraints.

${taskSection}

[1. CHART (project structure & architectural symbols)]
${chart}

[2. BALLAST (rules must follow)]
${ballastStr}

[3. MANIFEST (module status & key decisions)]
${manifest}
==================================================
`;
    logHookSucceeded(invocation, `memory context injected (${Buffer.byteLength(memoryCore, 'utf8')} bytes)`);
    return memoryCore;
  } catch (error) {
    logHookFailed(invocation, error);
    throw error;
  }
}
