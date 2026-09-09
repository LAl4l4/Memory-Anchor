import { readFile, writeFile } from 'node:fs/promises';
import { extractRepositoryRules } from '../../hooks/public/guardrailMaintenance.js';
import {
  GUARDRAILS_SPECIFIC_TITLE,
} from '../../constant.js';

/** Migrate managed defaults away while preserving repository rules. */
export async function ensureGuardrailsFile(guardrailsPath: string): Promise<boolean> {
  let existingSpecific: string[] = [];

  // Read existing specific rules if the file is already present
  try {
    const content = await readFile(guardrailsPath, 'utf8');
    existingSpecific = extractRepositoryRules(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // File doesn't exist — no specific rules to preserve
  }

  // Build the new content
  const specificBlock =
    existingSpecific.length > 0
      ? existingSpecific.join('\n')
      : '';

  const newContent = `${GUARDRAILS_SPECIFIC_TITLE}\n${specificBlock}\n`;

  // Only write if content actually changed (idempotent re-runs)
  try {
    const oldContent = await readFile(guardrailsPath, 'utf8');
    if (oldContent === newContent) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // File doesn't exist — proceed to write
  }

  await writeFile(guardrailsPath, newContent);
  return true;
}
