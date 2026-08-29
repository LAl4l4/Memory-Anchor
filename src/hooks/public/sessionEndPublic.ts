#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  CODE_EXTENSIONS,
  GUARDRAILS_DEFAULT_RULES,
  GUARDRAILS_DEFAULT_TITLE,
  GUARDRAILS_SPECIFIC_TITLE,
  STALE_BLACKLIST,
} from '../../constant.js';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';
import { updatePartitionedChartIncrementally } from '../../chartBuild/incremental.js';
import { destroyPool } from '../../chartBuild/buildChart.js';
import { logToUser } from '../../chartBuild/shared/utils.js';
import { appendDebugLog, formatError } from '../../utils/logger.js';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from './hookDebug.js';

const cwd = process.cwd();
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const GUARDRAILS_PATH = path.join(ANCHOR_PATH, 'guardrails.md');

export function updateProjectState(changes: GitChange[] | null): void {
  if (!changes || changes.length === 0) return;

  const parts: string[] = [];
  changes.forEach((c: GitChange) => {
    const statusMap: Record<string, string> = { M: 'Modified', A: 'Added', '??': 'Untracked' };
    const action = statusMap[c.status] || 'Changed';
    parts.push(`\`${c.file}\` (${action})`);
  });

  logToUser(`Code changes captured: ${parts.join('; ')}`, '36');
}

export function cleanGuardrailsRules(changes: GitChange[] | null): void {
  if (!fs.existsSync(GUARDRAILS_PATH) || !changes || changes.length === 0) return;

  let guardrailsContent = fs.readFileSync(GUARDRAILS_PATH, 'utf-8');
  let hasChanged = false;

  changes.forEach((c: GitChange) => {
    const fileBaseName = path.basename(c.file);
    const ext = path.extname(fileBaseName).toLowerCase();
    if (STALE_BLACKLIST.has(fileBaseName)) return;
    if (!CODE_EXTENSIONS.has(ext)) return;
    const fileKeyword = path.basename(c.file);
    const escapedKeyword = fileKeyword.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const ruleRegex = new RegExp(`(- \\[ \\].*${escapedKeyword}.*)`, 'g');

    if (ruleRegex.test(guardrailsContent)) {
      guardrailsContent = guardrailsContent.replace(ruleRegex, (match) => {
        hasChanged = true;
        if (match.includes('[STALE]')) return match;
        return `${match} [STALE] *(File changed in previous session. Verify if this rule is obsolete)*`;
      });
    }
  });

  if (hasChanged) {
    fs.writeFileSync(GUARDRAILS_PATH, guardrailsContent, 'utf-8');
    logToUser('Guardrails scanned. Potential obsolete rules marked with [STALE].', '35');
  }
}

function normalizeRuleLine(line: string): string {
  line = line.trim();

  // 已经是标准格式的，不动
  if (/^- \[( |x)\]\s+/.test(line)) {
    return line
  }

  line = line
    .replace(/^[-*]\s+/, '')        // - xxx  * xxx
    .replace(/^\d+\.\s+/, '')       // 1. xxx
    .replace(/^\[\s*\]\s+/, '')     // [] xxx  [ ] xxx
    .replace(/^\[\s*\]\s*/, '')     // 兜底

  return `- [ ] ${line}`
}

function normalizeLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // 只放过 # 开头的，别的都正则
  if (trimmed.startsWith('#')) return trimmed

  return normalizeRuleLine(trimmed)
}

export function sanitizeGuardrails(): void {
  if (!fs.existsSync(GUARDRAILS_PATH)) return;

  const content = fs.readFileSync(GUARDRAILS_PATH, 'utf8');
  const defaultSet = new Set(GUARDRAILS_DEFAULT_RULES.map((r) => r.trim()));

  const specificIndex = content.indexOf(GUARDRAILS_SPECIFIC_TITLE);

  let defaultRules: string[] = [];
  let specificRules: string[] = [];

  if (specificIndex !== -1) {
    const defaultSection = content.slice(0, specificIndex);
    const specificSection = content.slice(specificIndex);

    defaultRules = defaultSection
      .split('\n')
      .map(normalizeLine)
      .filter((l): l is string => l !== null)
      .filter((l) => !l.startsWith('#') && defaultSet.has(l));

    specificRules = specificSection
      .split('\n')
      .map(normalizeLine)
      .filter((l): l is string => l !== null)
      .filter((l) => !l.startsWith('#') && !defaultSet.has(l));
  } else {
    const allRules = content
      .split('\n')
      .map(normalizeLine)
      .filter((l): l is string => l !== null)
      .filter((l) => !l.startsWith('#'));

    defaultRules = allRules.filter((l) => defaultSet.has(l));
    specificRules = allRules.filter((l) => !defaultSet.has(l));
  }

  defaultRules = [...new Set(defaultRules)];
  specificRules = [...new Set(specificRules)];

  const defaultBlock = GUARDRAILS_DEFAULT_RULES.join('\n');
  const specificBlock = specificRules.length > 0 ? specificRules.join('\n') : '';

  const output = `${GUARDRAILS_DEFAULT_TITLE}\n${defaultBlock}\n\n${GUARDRAILS_SPECIFIC_TITLE}\n${specificBlock}\n`;
  fs.writeFileSync(GUARDRAILS_PATH, output, 'utf8');
  logToUser(`Guardrails normalized (${defaultRules.length} default, ${specificRules.length} specific)`, '35');
}

export async function runSessionEnd(): Promise<void> {
  const invocation = logHookTriggered(getHookInvocation());
  try {
    const changes = captureGitChanges();
    if (!changes || changes.length === 0) {
      appendDebugLog('debug', 'Session-end refresh skipped: Git reported no changes.');
      logHookSucceeded(invocation, 'skipped: Git reported no changes');
    } else {
      appendDebugLog('debug', `Session-end refresh captured ${changes.length} Git change(s).`);
      updateProjectState(changes);
      cleanGuardrailsRules(changes);
      sanitizeGuardrails();

      const changedPaths = changes.map((c) => c.file);
      await updatePartitionedChartIncrementally(changedPaths);
      appendDebugLog('debug', 'Session-end refresh completed.');
      logHookSucceeded(
        invocation,
        `session maintenance and incremental refresh completed for ${changes.length} Git change(s)`,
      );
    }
  } catch (error) {
    const message = `Session-end refresh failed: ${error instanceof Error ? error.message : error}`;
    logToUser(message, '31');
    appendDebugLog('error', `${message}\n${formatError(error)}`);
    logHookFailed(invocation, error);
    throw error;
  } finally {
    await destroyPool();
  }
  process.exit(0);
}
