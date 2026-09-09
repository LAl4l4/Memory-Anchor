import * as fs from 'node:fs';
import * as path from 'node:path';
import { GUARDRAILS_MANAGED_RULE_SET, GUARDRAILS_SPECIFIC_TITLE } from '../../constant.js';
import { logToUser } from '../../chartBuild/shared/utils.js';

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

/** Remove only recognized managed defaults, preserving custom rules in any section. */
export function extractRepositoryRules(content: string): string[] {
  return [...new Set(content.split('\n')
    .map(normalizeLine)
    .filter((line): line is string => line !== null && !line.startsWith('#'))
    .filter(line => !GUARDRAILS_MANAGED_RULE_SET.has(line)))];
}

export function sanitizeGuardrails(workdir = process.cwd()): void {
  const guardrailsPath = path.join(workdir, '.memoryanchor', 'guardrails.md');
  if (!fs.existsSync(guardrailsPath)) return;
  const rules = extractRepositoryRules(fs.readFileSync(guardrailsPath, 'utf8'));
  fs.writeFileSync(guardrailsPath, `${GUARDRAILS_SPECIFIC_TITLE}\n${rules.join('\n')}\n`, 'utf8');
  logToUser(`Guardrails normalized (${rules.length} repository rules)`, '35');
}
