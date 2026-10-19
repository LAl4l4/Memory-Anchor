import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

export async function readOptional(file: string): Promise<string> {
  try { return await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function readConfig(file: string): Promise<JsonObject> {
  const content = await readOptional(file);
  return asObject(content.trim() ? JSON.parse(content) : {}, file);
}

export async function saveConfig(file: string, config: JsonObject): Promise<boolean> {
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (await readOptional(file) === next) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, 'utf8');
  return true;
}
