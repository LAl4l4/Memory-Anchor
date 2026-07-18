import { readFile, writeFile } from 'node:fs/promises';
import { BALLAST_DEFAULT_RULES, BALLAST_DEFAULT_TITLE, BALLAST_SPECIFIC_TITLE } from '../constant.js';

/**
 * Extract specific rules from existing ballast.md content.
 *
 * Strategy:
 * 1. If the BALLAST_SPECIFIC_TITLE marker exists, extract everything after it.
 * 2. Otherwise, extract every line that is NOT a default rule (handles files
 *    that may have been flattened/cleaned by sanitizeBallast or earlier init).
 */
function extractSpecificRules(content: string): string[] {
  const defaultSet = new Set(BALLAST_DEFAULT_RULES.map((r) => r.trim()));

  // Try section-marker approach first
  const specificIndex = content.indexOf(BALLAST_SPECIFIC_TITLE);
  if (specificIndex !== -1) {
    const after = content.slice(specificIndex + BALLAST_SPECIFIC_TITLE.length);
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
 * Write ballast.md with a two-section format:
 *   1. Default rules (always replaced from BALLAST_DEFAULT_RULES)
 *   2. Specific rules (preserved from existing file when possible)
 *
 * Returns whether the file was written (always true on first init,
 * false only if the content hasn't changed on re-run).
 */
export async function ensureBallastFile(ballastPath: string): Promise<boolean> {
  let existingSpecific: string[] = [];

  // Read existing specific rules if the file is already present
  try {
    const content = await readFile(ballastPath, 'utf8');
    existingSpecific = extractSpecificRules(content);
  } catch {
    // File doesn't exist — no specific rules to preserve
  }

  // Build the new content
  const defaultBlock = BALLAST_DEFAULT_RULES.join('\n');
  const specificBlock =
    existingSpecific.length > 0
      ? existingSpecific.join('\n')
      : '';

  const newContent = `${BALLAST_DEFAULT_TITLE}\n${defaultBlock}\n\n${BALLAST_SPECIFIC_TITLE}\n${specificBlock}\n`;

  // Only write if content actually changed (idempotent re-runs)
  try {
    const oldContent = await readFile(ballastPath, 'utf8');
    if (oldContent === newContent) return false;
  } catch {
    // File doesn't exist — proceed to write
  }

  await writeFile(ballastPath, newContent);
  return true;
}
