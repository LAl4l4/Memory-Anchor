import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PROMPT_HOOK_AGENTS,
  PROMPT_HOOK_CONFIG_DEFAULT_CONTENT,
  PROMPT_HOOK_CONFIG_FILE_NAME,
  type PromptHookAgent,
} from '../../constant.js';

interface PromptHookConfig {
  enabled?: unknown;
}

const PROMPT_HOOK_ALIASES: Record<string, PromptHookAgent> = {
  claude: 'claude',
  codex: 'codex',
  codebuddy: 'codebuddy',
  copilot: 'copilot',
  opencode: 'opencode',
  'open-code': 'opencode',
  qoder: 'qodercn',
  qodercn: 'qodercn',
  'qoder-cn': 'qodercn',
};

export function getPromptHookConfigPath(cwd: string): string {
  return path.join(cwd, '.memoryanchor', PROMPT_HOOK_CONFIG_FILE_NAME);
}

export function getPromptHookAgentName(value: string): PromptHookAgent | null {
  return PROMPT_HOOK_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function normalizePromptHookAgents(values: readonly string[]): PromptHookAgent[] {
  const selected = new Set<PromptHookAgent>();
  for (const value of values) {
    const agent = getPromptHookAgentName(value);
    if (agent) selected.add(agent);
  }

  return PROMPT_HOOK_AGENTS.filter((agent) => selected.has(agent));
}

async function readConfig(cwd: string): Promise<PromptHookConfig> {
  try {
    return JSON.parse(await readFile(getPromptHookConfigPath(cwd), 'utf8')) as PromptHookConfig;
  } catch {
    return {};
  }
}

export async function readPromptHookAgents(cwd: string): Promise<PromptHookAgent[]> {
  const config = await readConfig(cwd);
  if (!Array.isArray(config.enabled)) return [];

  return normalizePromptHookAgents(
    config.enabled.filter((value): value is string => typeof value === 'string'),
  );
}

export async function isPromptHookEnabled(
  cwd: string,
  agent: PromptHookAgent,
): Promise<boolean> {
  return (await readPromptHookAgents(cwd)).includes(agent);
}

export async function ensurePromptHookConfig(memoryAnchorDir: string): Promise<boolean> {
  const configPath = path.join(memoryAnchorDir, PROMPT_HOOK_CONFIG_FILE_NAME);
  try {
    await readFile(configPath, 'utf8');
    return false;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error;
    }
  }

  await mkdir(memoryAnchorDir, { recursive: true });
  await writeFile(configPath, PROMPT_HOOK_CONFIG_DEFAULT_CONTENT, 'utf8');
  return true;
}

export async function writePromptHookAgents(
  cwd: string,
  agents: readonly PromptHookAgent[],
): Promise<boolean> {
  const normalized = normalizePromptHookAgents(agents);
  const current = await readPromptHookAgents(cwd);
  if (current.length === normalized.length && current.every((agent, index) => agent === normalized[index])) {
    return false;
  }

  const configPath = getPromptHookConfigPath(cwd);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ enabled: normalized }, null, 2)}\n`, 'utf8');
  return true;
}

export function allPromptHookAgents(): PromptHookAgent[] {
  return [...PROMPT_HOOK_AGENTS];
}

/** Remove one managed nested command while preserving user-owned entries. */
export function removeNestedPromptHook(
  hooks: Record<string, unknown>,
  key: string,
  command: string,
): boolean {
  const entries = hooks[key];
  if (entries === undefined) return false;
  if (!Array.isArray(entries)) throw new Error(`Hook list "${key}" must be an array.`);

  let removed = false;
  const remaining = entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || !Array.isArray((entry as { hooks?: unknown }).hooks)) {
        return entry;
      }

      const nestedHooks = (entry as { hooks: Array<{ command?: unknown }> }).hooks.filter((hook) => {
        const isManaged = hook && hook.command === command;
        removed = removed || Boolean(isManaged);
        return !isManaged;
      });
      return { ...(entry as object), hooks: nestedHooks };
    })
    .filter((entry) => {
      if (!entry || typeof entry !== 'object' || !Array.isArray((entry as { hooks?: unknown }).hooks)) {
        return true;
      }
      return (entry as { hooks: unknown[] }).hooks.length > 0;
    });

  if (!removed) return false;
  if (remaining.length === 0) delete hooks[key];
  else hooks[key] = remaining;
  return true;
}

/** Remove one managed Copilot command while preserving user-owned entries. */
export function removeFlatPromptHook(
  hooks: Record<string, unknown>,
  key: string,
  command: string,
): boolean {
  const entries = hooks[key];
  if (entries === undefined) return false;
  if (!Array.isArray(entries)) throw new Error(`Hook list "${key}" must be an array.`);

  const remaining = entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    const item = entry as { bash?: unknown; powershell?: unknown; command?: unknown };
    return item.bash !== command && item.powershell !== command && item.command !== command;
  });
  if (remaining.length === entries.length) return false;
  if (remaining.length === 0) delete hooks[key];
  else hooks[key] = remaining;
  return true;
}
