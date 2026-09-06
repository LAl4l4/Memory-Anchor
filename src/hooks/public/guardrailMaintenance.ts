import * as fs from 'node:fs';
import * as path from 'node:path';
import { GUARDRAILS_DEFAULT_RULES, GUARDRAILS_DEFAULT_TITLE, GUARDRAILS_SPECIFIC_TITLE } from '../../constant.js';
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

export function sanitizeGuardrails(workdir = process.cwd()): void {
  const GUARDRAILS_PATH = path.join(workdir, '.memoryanchor', 'guardrails.md');
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

