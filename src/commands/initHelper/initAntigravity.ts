import { CAC } from 'cac';
import path from 'node:path';
import type { CommandContext } from '../../types.js';
import { HOOK_COMMANDS } from '../../constant.js';
import type { AntigravityEventName } from './hookProtocol.js';
import { initPublic } from './initPublic.js';
import { registerMcp } from './initMcp.js';
import { isPromptHookEnabled } from './promptHookConfig.js';
import { asObject, readConfig, saveConfig, type JsonObject } from './jsonConfig.js';

const HOOK_GROUP_NAME = 'memory-anchor';

export interface AntigravitySetupResult {
  hooksUpdated: boolean;
}

async function ensureAntigravityHooks(cwd: string): Promise<boolean> {
  const file = path.join(cwd, '.agents', 'hooks.json');
  const config = await readConfig(file);
  const group = asObject(config[HOOK_GROUP_NAME] ?? {}, HOOK_GROUP_NAME);
  config[HOOK_GROUP_NAME] = group;

  addAntigravityHook(group, 'SessionStart', {
    type: 'command',
    command: HOOK_COMMANDS.ANTIGRAVITY_PRE,
    timeout: 10,
  });
  addAntigravityHook(group, 'Stop', {
    type: 'command',
    command: HOOK_COMMANDS.ANTIGRAVITY_STOP,
    timeout: 120,
  });

  if (await isPromptHookEnabled(cwd, 'antigravity')) {
    addAntigravityHook(group, 'PreInvocation', {
      type: 'command',
      command: HOOK_COMMANDS.ANTIGRAVITY_PROMPT,
      timeout: 10,
    });
  } else {
    removeAntigravityHook(group, 'PreInvocation', HOOK_COMMANDS.ANTIGRAVITY_PROMPT);
  }

  return saveConfig(file, config);
}

export async function antigravitySetup(cwd: string): Promise<AntigravitySetupResult> {
  const hooksUpdated = await ensureAntigravityHooks(cwd);
  return { hooksUpdated };
}

export function initAntigravityCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('init-antigravity', 'Initialize Antigravity MemoryAnchor workspace')
    .action(async () => {
      const cwd = process.cwd();
      const common = await initPublic(cwd);
      const specific = await antigravitySetup(cwd);
      const mcpUpdated = await registerMcp(cwd, 'antigravity');
      const updated =
        mcpUpdated ||
        common.gitignoreUpdated ||
        common.anchorFilesCreated ||
        common.agentsCreated ||
        specific.hooksUpdated;
      context.logger.info(
        updated
          ? 'Memory anchor initialized for Antigravity in ./.memoryanchor and ./.agents'
          : 'Memory anchor for Antigravity already exists in ./.memoryanchor and ./.agents',
      );
    });
}

/** Add only our flat lifecycle handler; never overwrite user entries or enabled flags. */
function addAntigravityHook(
  group: JsonObject,
  event: AntigravityEventName,
  hook: JsonObject,
): void {
  const entries = group[event] ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`Hook list ${event} must be an array.`);
  }
  for (const entry of entries) {
    const existing = asObject(entry, `${event} handler`);
    if (existing.command === hook.command) return;
  }
  group[event] = [...entries, hook];
}

/** Remove only our managed command while preserving unrelated handlers. */
function removeAntigravityHook(
  group: JsonObject,
  event: AntigravityEventName,
  command: string,
): void {
  const entries = group[event];
  if (entries === undefined) return;
  if (!Array.isArray(entries)) {
    throw new Error(`Hook list ${event} must be an array.`);
  }
  const remaining = entries.filter((entry) => {
    const existing = asObject(entry, `${event} handler`);
    return existing.command !== command;
  });
  if (remaining.length === entries.length) return;
  if (remaining.length === 0) {
    delete group[event];
  } else {
    group[event] = remaining;
  }
}
