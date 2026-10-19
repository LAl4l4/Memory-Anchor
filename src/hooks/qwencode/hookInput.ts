import { existsSync } from 'node:fs';
import path from 'node:path';
import { getHookInvocation, logHookFailed } from '../public/hookDebug.js';

/** Qwen command hooks send a JSON payload; unknown fields remain forward-compatible. */
export async function prepareQwencodeWorkspace(): Promise<boolean> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Qwencode hook input must be an object.');
  }
  const cwd = (input as { cwd?: unknown }).cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new Error('Qwencode hook cwd must be absolute.');
    }
    process.chdir(cwd);
  }
  return existsSync(path.join(process.cwd(), '.memoryanchor'));
}

export function reportQwencodeHookError(event: string, error: unknown): void {
  logHookFailed(getHookInvocation(), error);
  process.stderr.write(`Memory Anchor qwencode ${event}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
