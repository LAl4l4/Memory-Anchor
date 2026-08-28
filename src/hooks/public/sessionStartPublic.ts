#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { BALLAST_MAX_BYTES, MANIFEST_MODULE_STATUS_MAX_BYTES } from '../../constant.js';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from './hookDebug.js';

const cwd = process.cwd();
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const INDEX_PATH = path.join(ANCHOR_PATH, 'index.md');
const ROOT_CHART_PATH = path.join(ANCHOR_PATH, 'chart', 'chart.md');
const BALLAST_PATH = path.join(ANCHOR_PATH, 'ballast.md');
const MANIFEST_PATH = path.join(ANCHOR_PATH, 'manifest.md');

function extractManifestModuleStatus(manifest: string): string {
  const moduleHeading = /^##\s+Module Status\s*$/m;
  const headingMatch = moduleHeading.exec(manifest);
  if (!headingMatch) return '';

  const sectionStart = headingMatch.index;
  const afterHeading = sectionStart + headingMatch[0].length;
  const nextSectionMatch = /^##\s+Key Decisions\s*$/m.exec(manifest.slice(afterHeading));
  const sectionEnd = nextSectionMatch
    ? afterHeading + nextSectionMatch.index
    : manifest.length;
  return manifest.slice(sectionStart, sectionEnd).trim();
}

function buildMemoryCompactionMission(ballast: string, manifest: string): string {
  const ballastBytes = Buffer.byteLength(ballast, 'utf8');
  const moduleStatusBytes = Buffer.byteLength(extractManifestModuleStatus(manifest), 'utf8');
  const ballastOverLimit = ballastBytes > BALLAST_MAX_BYTES;
  const moduleStatusOverLimit = moduleStatusBytes > MANIFEST_MODULE_STATUS_MAX_BYTES;
  if (!ballastOverLimit && !moduleStatusOverLimit) return '';

  const exceeded: string[] = [];
  const actions: string[] = [];
  if (ballastOverLimit) {
    exceeded.push(
      `- \`.memoryanchor/ballast.md\` is ${ballastBytes} UTF-8 bytes; limit: ${BALLAST_MAX_BYTES} bytes.`,
    );
    actions.push(
      '- Shorten `ballast.md`: preserve every default rule, remove obsolete or duplicate specific rules, merge into existing rules first, and add a rule only for a distinct durable repository constraint.',
    );
  }
  if (moduleStatusOverLimit) {
    exceeded.push(
      `- The \`## Module Status\` section of \`.memoryanchor/manifest.md\` is ${moduleStatusBytes} UTF-8 bytes; limit: ${MANIFEST_MODULE_STATUS_MAX_BYTES} bytes.`,
    );
    actions.push(
      '- Shorten only the `## Module Status` section: merge duplicate modules and replace historical detail with concise current state while preserving functionality, status, dependencies, known issues, and essential notes.',
    );
  }

  return `
[TRIGGERED MISSION: MEMORY COMPACTION]
- Urgent Status: Persistent memory exceeded its configured injection length limit.
${exceeded.join('\n')}
- Your Action Required: During this session, edit the over-limit file sections and bring them within their limits before completing the current task.
${actions.join('\n')}
`;
}

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
    let taskSection = buildMemoryCompactionMission(ballastStr, manifest);
    if (hasStaleRules) {
      taskSection += `
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
