#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  GUARDRAILS_MAX_BYTES,
  PROJECT_STATE_MODULE_STATUS_MAX_BYTES,
} from '../../constant.js';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from './hookDebug.js';

const cwd = process.cwd();
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const INDEX_PATH = path.join(ANCHOR_PATH, 'index.md');
const ROOT_CHART_PATH = path.join(ANCHOR_PATH, 'chart', 'chart.md');
const GUARDRAILS_PATH = path.join(ANCHOR_PATH, 'guardrails.md');
const PROJECT_STATE_PATH = path.join(ANCHOR_PATH, 'project-state.md');

function extractProjectStateModuleStatus(projectState: string): string {
  const moduleHeading = /^##\s+Module Status\s*$/m;
  const headingMatch = moduleHeading.exec(projectState);
  if (!headingMatch) return '';

  const sectionStart = headingMatch.index;
  const afterHeading = sectionStart + headingMatch[0].length;
  const nextSectionMatch = /^##\s+Key Decisions\s*$/m.exec(projectState.slice(afterHeading));
  const sectionEnd = nextSectionMatch
    ? afterHeading + nextSectionMatch.index
    : projectState.length;
  return projectState.slice(sectionStart, sectionEnd).trim();
}

function buildMemoryCompactionMission(guardrails: string, projectState: string): string {
  const guardrailsBytes = Buffer.byteLength(guardrails, 'utf8');
  const moduleStatusBytes = Buffer.byteLength(extractProjectStateModuleStatus(projectState), 'utf8');
  const guardrailsOverLimit = guardrailsBytes > GUARDRAILS_MAX_BYTES;
  const moduleStatusOverLimit = moduleStatusBytes > PROJECT_STATE_MODULE_STATUS_MAX_BYTES;
  if (!guardrailsOverLimit && !moduleStatusOverLimit) return '';

  const exceeded: string[] = [];
  const actions: string[] = [];
  if (guardrailsOverLimit) {
    exceeded.push(
      `- \`.memoryanchor/guardrails.md\` is ${guardrailsBytes} UTF-8 bytes; limit: ${GUARDRAILS_MAX_BYTES} bytes.`,
    );
    actions.push(
      '- Shorten `guardrails.md`: preserve every default rule, remove obsolete or duplicate repository-specific rules, merge into existing rules first, and add a rule only for a distinct durable repository constraint.',
    );
  }
  if (moduleStatusOverLimit) {
    exceeded.push(
      `- The \`## Module Status\` section of \`.memoryanchor/project-state.md\` is ${moduleStatusBytes} UTF-8 bytes; limit: ${PROJECT_STATE_MODULE_STATUS_MAX_BYTES} bytes.`,
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

    let guardrails = 'No active coding constraints or lessons-learned enforced.';
    if (fs.existsSync(GUARDRAILS_PATH)) {
      guardrails = fs.readFileSync(GUARDRAILS_PATH, 'utf-8').trim();
    }

    let projectState = 'No active cross-session tasks found.';
    if (fs.existsSync(PROJECT_STATE_PATH)) {
      projectState = fs.readFileSync(PROJECT_STATE_PATH, 'utf-8').trim();
    }

    const hasStaleRules = guardrails.includes('[STALE]');
    let taskSection = buildMemoryCompactionMission(guardrails, projectState);
    if (hasStaleRules) {
      taskSection += `
[TRIGGERED MISSION: MEMORY PRUNING]
- Urgent Status: Some developer-enforced limits inside the [2. GUARDRAILS] section are currently flagged with '[STALE]'.
- Your Action Required: These rules are likely obsolete due to recent code changes. You MUST evaluate and directly rewrite '.memoryanchor/guardrails.md' to DELETE any invalid stale rules during this session.
`;
    }

    const memoryCore = `
==================================================
[MEMORY ANCHOR: CONTEXT INJECTED]
Target: Assist the developer by ensuring all generated code aligns with local repository constraints.

${taskSection}

[1. CHART (project structure & architectural symbols)]
${chart}

[2. GUARDRAILS (rules must follow)]
${guardrails}

[3. PROJECT STATE (module status & key decisions)]
${projectState}
==================================================
`;
    logHookSucceeded(invocation, `memory context injected (${Buffer.byteLength(memoryCore, 'utf8')} bytes)`);
    return memoryCore;
  } catch (error) {
    logHookFailed(invocation, error);
    throw error;
  }
}
