#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { BALLAST_DEFAULT_RULES, BALLAST_DEFAULT_TITLE, BALLAST_SPECIFIC_TITLE, CODE_EXTENSIONS, STALE_BLACKLIST } from '../../constant.js';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';
import { updateChartIncrementally, destroyPool } from '../../chartBuild/build-chart.js';

const cwd = process.cwd();
const ANCHOR_PATH = path.join(cwd, '.memoryanchor');
const BALLAST_PATH = path.join(ANCHOR_PATH, 'ballast.md');

function logToUser(message: string, colorCode: string = '36'): void {
  process.stderr.write(`\x1b[${colorCode}m[Memory Anchor] ${message}\x1b[0m\n`);
}

export function updateManifest(changes: GitChange[] | null): void {
  if (!changes || changes.length === 0) return;

  const parts: string[] = [];
  changes.forEach((c: GitChange) => {
    const statusMap: Record<string, string> = { M: 'Modified', A: 'Added', '??': 'Untracked' };
    const action = statusMap[c.status] || 'Changed';
    parts.push(`\`${c.file}\` (${action})`);
  });

  logToUser(`Code changes captured: ${parts.join('; ')}`, '36');
}

export function cleanBallastRules(changes: GitChange[] | null): void {
  if (!fs.existsSync(BALLAST_PATH) || !changes || changes.length === 0) return;

  let ballastContent = fs.readFileSync(BALLAST_PATH, 'utf-8');
  let hasChanged = false;

  changes.forEach((c: GitChange) => {
    const fileBaseName = path.basename(c.file);
    const ext = path.extname(fileBaseName).toLowerCase();
    if (STALE_BLACKLIST.has(fileBaseName)) return;
    if (!CODE_EXTENSIONS.has(ext)) return;
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
    logToUser('Ballast scanned. Potential obsolete rules marked with [STALE].', '35');
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

export function sanitizeBallast(): void {
  if (!fs.existsSync(BALLAST_PATH)) return;

  const content = fs.readFileSync(BALLAST_PATH, 'utf8');
  const defaultSet = new Set(BALLAST_DEFAULT_RULES.map((r) => r.trim()));

  const specificIndex = content.indexOf(BALLAST_SPECIFIC_TITLE);

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

  const defaultBlock = BALLAST_DEFAULT_RULES.join('\n');
  const specificBlock = specificRules.length > 0 ? specificRules.join('\n') : '';

  const output = `${BALLAST_DEFAULT_TITLE}\n${defaultBlock}\n\n${BALLAST_SPECIFIC_TITLE}\n${specificBlock}\n`;
  fs.writeFileSync(BALLAST_PATH, output, 'utf8');
  logToUser(`Ballast normalized (${defaultRules.length} default, ${specificRules.length} specific)`, '35');
}

export async function runSessionEnd(): Promise<void> {
  const changes = captureGitChanges();
  if (changes && changes.length > 0) {
    updateManifest(changes);
    cleanBallastRules(changes);
    sanitizeBallast();

    const changedPaths = changes.map((c) => c.file);
    await updateChartIncrementally(changedPaths);
  }

  await destroyPool();
  process.exit(0);
}
