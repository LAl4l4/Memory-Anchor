import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, YAMLSeq } from 'yaml';
import { asObject, readOptional, type JsonObject } from './jsonConfig.js';

export const DEEPSEEK_PATCH = '.memoryanchor/deepseek/cordis.patch.yml';
export const DEEPSEEK_HOOKS = '.memoryanchor/deepseek/hooks.json';

/**
 * Dedicated opt-in overlay; preserve existing rows, comments and disabled entries.
 * With `refresh`, an existing row with the same id is replaced by its result; null keeps the row.
 */
export async function addDeepseekEntry(cwd: string, entry: JsonObject,
  refresh?: (existing: JsonObject) => JsonObject | null): Promise<boolean> {
  const file = path.join(cwd, DEEPSEEK_PATCH);
  const content = await readOptional(file);
  let doc = parseDocument(content);
  if (doc.errors.length) throw new Error(`Invalid DeepSeek patch: ${doc.errors[0].message}`);
  if (doc.contents === null) doc = parseDocument(`${content}\n[]\n`);
  if (!(doc.contents instanceof YAMLSeq)) throw new Error('DeepSeek patch must be a YAML sequence.');
  const patches = doc.toJS() as unknown[];
  for (const [patchIndex, patch] of patches.entries()) {
    const insert = asObject(patch, 'DeepSeek patch entry').insert;
    if (!Array.isArray(insert)) continue;
    const rowIndex = insert.findIndex(row => asObject(row, 'DeepSeek plugin').id === entry.id);
    if (rowIndex < 0) continue;
    const existing = asObject(insert[rowIndex], 'DeepSeek plugin');
    const next = refresh?.(existing);
    if (!next || JSON.stringify(next) === JSON.stringify(existing)) return false;
    const rows = doc.contents.items[patchIndex];
    const seq = rows && typeof rows === 'object' && 'get' in rows ? (rows as any).get('insert', true) : undefined;
    if (!(seq instanceof YAMLSeq)) return false;
    seq.items[rowIndex] = doc.createNode(next);
    await writeFile(file, doc.toString(), 'utf8');
    return true;
  }
  doc.add({ insert: [entry] });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, doc.toString(), 'utf8');
  return true;
}
