#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { CODE_EXTENSIONS, STALE_BLACKLIST } from '../../constant.js';
import { captureGitChanges, GitChange } from '../../utils/captureGitChanges.js';
import { buildChartFull } from '../../core/build-chart.js';

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

export function sanitizeBallast(): void {
  if (!fs.existsSync(BALLAST_PATH)) return;

  const content = fs.readFileSync(BALLAST_PATH, 'utf8');

  const headings: string[] = [];
  const ruleLines: string[] = [];

  content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      // Preserve markdown headings — don't treat them as rules
      if (line.startsWith('#')) {
        headings.push(line);
        return;
      }
      if (line.startsWith('Note:') || line.startsWith('Explanation:') || line.startsWith('Rule:')) {
        return;
      }
      line = line
        .replace(/^\*/, '-')
        .replace(/^\d+\./, '-')
        .replace(/^\[\]/, '- [ ]')
        .replace(/^-?\s*\[\]/, '- [ ]');

      if (!/^- \[[ x]\]/.test(line)) {
        line = `- [ ] ${line}`;
      }
      ruleLines.push(line);
    });

  const unique = [...new Set(ruleLines)];
  const output = [...headings, ...unique].join('\n');
  fs.writeFileSync(BALLAST_PATH, output, 'utf8');
  logToUser(`Ballast normalized (${unique.length} rules)`, '35');
}

export async function runSessionEnd(): Promise<void> {
  const changes = captureGitChanges();
  if (changes && changes.length > 0) {
    updateManifest(changes);
    cleanBallastRules(changes);
    sanitizeBallast();
  }

  await buildChartFull();
  process.exit(0);
}
