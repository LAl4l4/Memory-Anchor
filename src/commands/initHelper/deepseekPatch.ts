import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, YAMLSeq } from 'yaml';
import { asObject, readOptional, type JsonObject } from './jsonConfig.js';

export const DEEPSEEK_PATCH = '.memoryanchor/deepseek/cordis.patch.yml';
export const DEEPSEEK_HOOKS = '.memoryanchor/deepseek/hooks.json';

/** Dedicated opt-in overlay; preserve existing rows, comments and disabled entries. */
export async function addDeepseekEntry(cwd: string, entry: JsonObject): Promise<boolean> {
  const file = path.join(cwd, DEEPSEEK_PATCH);
  const content = await readOptional(file);
  let doc = parseDocument(content);
  if (doc.errors.length) throw new Error(`Invalid DeepSeek patch: ${doc.errors[0].message}`);
  if (doc.contents === null) doc = parseDocument(`${content}\n[]\n`);
  if (!(doc.contents instanceof YAMLSeq)) throw new Error('DeepSeek patch must be a YAML sequence.');
  const patches = doc.toJS() as unknown[];
  for (const patch of patches) {
    const insert = asObject(patch, 'DeepSeek patch entry').insert;
    if (Array.isArray(insert) && insert.some(row => asObject(row, 'DeepSeek plugin').id === entry.id)) return false;
  }
  doc.add({ insert: [entry] });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, doc.toString(), 'utf8');
  return true;
}
