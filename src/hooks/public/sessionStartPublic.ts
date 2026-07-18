#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

const cwd = process.cwd();
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const CHART_PATH = path.join(ANCHOR_PATH, 'chart.md');
const BALLAST_PATH = path.join(ANCHOR_PATH, 'ballast.md');
const MANIFEST_PATH = path.join(ANCHOR_PATH, 'manifest.md');

export function loadMemoryCore(): string {
  let chart = 'No project chart available.';
  if (fs.existsSync(CHART_PATH)) {
    chart = fs.readFileSync(CHART_PATH, 'utf-8').trim();
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

  return `
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
}
