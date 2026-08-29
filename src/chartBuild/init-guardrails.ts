import { readFile, writeFile } from 'node:fs/promises';
import {
  GUARDRAILS_DEFAULT_RULES,
  GUARDRAILS_DEFAULT_TITLE,
  GUARDRAILS_SPECIFIC_TITLE,
} from '../constant.js';

const LEGACY_SPECIFIC_TITLE =
  '# Specific Rules For This Repository(Change this after solve bugs or user add specific rules)';

/**
 * Extract repository-specific rules from existing guardrails.md content.
 *
 * Strategy:
 * 1. If the GUARDRAILS_SPECIFIC_TITLE marker exists, extract everything after it.
 * 2. Otherwise, extract every line that is NOT a default rule (handles files
 *    that may have been flattened/cleaned by sanitizeGuardrails or earlier init).
 */
function extractSpecificRules(content: string): string[] {
  const defaultSet = new Set(GUARDRAILS_DEFAULT_RULES.map((r) => r.trim()));

  // Try current and legacy section markers before falling back to flat content.
  const specificTitle = [GUARDRAILS_SPECIFIC_TITLE, LEGACY_SPECIFIC_TITLE]
    .find((title) => content.includes(title));
  const specificIndex = specificTitle ? content.indexOf(specificTitle) : -1;
  if (specificIndex !== -1) {
    const after = content.slice(specificIndex + specificTitle!.length);
    return after
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.startsWith('#') && !defaultSet.has(l));
  }

  // Fallback: treat all non-default, non-header lines as specific
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('#') && !defaultSet.has(l));
}

/**
 * Write guardrails.md with a two-section format:
 *   1. Default rules (always replaced from GUARDRAILS_DEFAULT_RULES)
 *   2. Specific rules (preserved from existing file when possible)
 *
 * Returns whether the file was written (always true on first init,
 * false only if the content hasn't changed on re-run).
 */
export async function ensureGuardrailsFile(guardrailsPath: string): Promise<boolean> {
  let existingSpecific: string[] = [];

  // Read existing specific rules if the file is already present
  try {
    const content = await readFile(guardrailsPath, 'utf8');
    existingSpecific = extractSpecificRules(content);
  } catch {
    // File doesn't exist — no specific rules to preserve
  }

  // Build the new content
  const defaultBlock = GUARDRAILS_DEFAULT_RULES.join('\n');
  const specificBlock =
    existingSpecific.length > 0
      ? existingSpecific.join('\n')
      : '';

  const newContent = `${GUARDRAILS_DEFAULT_TITLE}\n${defaultBlock}\n\n${GUARDRAILS_SPECIFIC_TITLE}\n${specificBlock}\n`;

  // Only write if content actually changed (idempotent re-runs)
  try {
    const oldContent = await readFile(guardrailsPath, 'utf8');
    if (oldContent === newContent) return false;
  } catch {
    // File doesn't exist — proceed to write
  }

  await writeFile(guardrailsPath, newContent);
  return true;
}
