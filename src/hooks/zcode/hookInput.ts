import { existsSync } from 'node:fs';
import path from 'node:path';
import { getHookInvocation, logHookFailed } from '../public/hookDebug.js';

/** ZCode hooks are global, so resolve the event cwd before accessing repository memory. */
export async function prepareZcodeWorkspace(): Promise<boolean> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Zcode hook input must be an object.');
  }
  const cwd = (input as { cwd?: unknown }).cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new Error('Zcode hook cwd must be absolute.');
    }
    process.chdir(cwd);
  }
  return existsSync(path.join(process.cwd(), '.memoryanchor'));
}

export function reportZcodeHookError(event: string, error: unknown): void {
  logHookFailed(getHookInvocation(), error);
  process.stderr.write(`Memory Anchor zcode ${event}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
