import { existsSync } from 'node:fs';
import path from 'node:path';
import { getHookInvocation, logHookFailed } from '../public/hookDebug.js';

interface AntigravityHookPayload {
  cwd?: unknown;
  workspacePaths?: unknown;
}

function hasMemoryAnchor(dir: string): boolean {
  return existsSync(path.join(dir, '.memoryanchor'));
}

function isWithinDir(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseWorkspacePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Antigravity hook workspacePaths must be an array.');
  }
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error('Antigravity hook workspacePaths entries must be strings.');
    }
    if (item.length > 0 && path.isAbsolute(item)) {
      paths.push(item);
    }
  }
  return paths;
}

/**
 * Antigravity command hooks receive a camelCase JSON payload on stdin and run
 * with process.cwd() set to the directory containing hooks.json (e.g. .agents).
 */
export async function prepareAntigravityWorkspace(): Promise<boolean> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Antigravity hook input must be an object.');
  }

  const payload = input as AntigravityHookPayload;
  if (payload.cwd !== undefined) {
    if (typeof payload.cwd !== 'string') {
      throw new Error('Antigravity hook cwd must be a string.');
    }
    if (payload.cwd.length > 0 && !path.isAbsolute(payload.cwd)) {
      throw new Error('Antigravity hook cwd must be absolute.');
    }
  }

  const workspacePaths = parseWorkspacePaths(payload.workspacePaths);
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : undefined;

  if (cwd !== undefined) {
    if (hasMemoryAnchor(cwd)) {
      process.chdir(cwd);
      return true;
    }
    const matchingWorkspace = workspacePaths.find(
      (workspacePath) => isWithinDir(cwd, workspacePath) && hasMemoryAnchor(workspacePath),
    );
    if (matchingWorkspace) {
      process.chdir(matchingWorkspace);
      return true;
    }
    process.chdir(cwd);
    return false;
  }

  if (workspacePaths.length > 0) {
    const initializedWorkspace = workspacePaths.find((workspacePath) => hasMemoryAnchor(workspacePath));
    if (initializedWorkspace) {
      process.chdir(initializedWorkspace);
      return true;
    }
    return false;
  }

  const currentCwd = process.cwd();
  if (hasMemoryAnchor(currentCwd)) {
    return true;
  }
  // Antigravity executes hooks from the directory containing hooks.json (.agents).
  if (path.basename(currentCwd) === '.agents') {
    const parent = path.dirname(currentCwd);
    if (hasMemoryAnchor(parent)) {
      process.chdir(parent);
      return true;
    }
  }
  return false;
}

export function reportAntigravityHookError(event: string, error: unknown): void {
  logHookFailed(getHookInvocation(), error);
  process.stderr.write(
    `Memory Anchor antigravity ${event}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
