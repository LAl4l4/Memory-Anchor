import { CAC } from 'cac';
import path from 'node:path';
import type { CommandContext } from '../../types.js';
import { HOOK_COMMANDS } from '../../constant.js';
import { initPublic } from './initPublic.js';
import { registerMcp } from './initMcp.js';
import { isPromptHookEnabled, removeNestedPromptHook } from './promptHookConfig.js';
import { asObject, readConfig, saveConfig, type JsonObject } from './jsonConfig.js';
import { addDeepseekEntry, DEEPSEEK_HOOKS, DEEPSEEK_PATCH } from './deepseekPatch.js';

export interface DeepseekSetupResult {
  hooksUpdated: boolean;
  patchUpdated: boolean;
}

async function ensureDeepseekHooks(cwd: string): Promise<boolean> {
  const file = path.join(cwd, DEEPSEEK_HOOKS);
  const config = await readConfig(file);
  const hooks = asObject(config.hooks ?? {}, 'hooks');
  config.hooks = hooks;
  addDeepseekHook(hooks, 'SessionStart', { type: 'command', command: HOOK_COMMANDS.DEEPSEEK_PRE, timeout: 10 });
  // The official bridge has no SessionEnd event.
  addDeepseekHook(hooks, 'Stop', { type: 'command', command: HOOK_COMMANDS.DEEPSEEK_STOP, timeout: 120 });
  if (await isPromptHookEnabled(cwd, 'deepseek')) {
    addDeepseekHook(hooks, 'UserPromptSubmit', { type: 'command', command: HOOK_COMMANDS.DEEPSEEK_PROMPT, timeout: 10 });
  } else {
    removeNestedPromptHook(hooks, 'UserPromptSubmit', HOOK_COMMANDS.DEEPSEEK_PROMPT);
  }
  return saveConfig(file, config);
}

export async function deepseekSetup(cwd: string): Promise<DeepseekSetupResult> {
  const hooksUpdated = await ensureDeepseekHooks(cwd);
  const patchUpdated = await addDeepseekEntry(cwd, {
    id: 'memory-anchor-hooks', name: '@deepseek-ai/dsh-hooks-codex',
    config: { configPath: path.resolve(cwd, DEEPSEEK_HOOKS) },
  });
  return { hooksUpdated, patchUpdated };
}

export function reportDeepseekSetup(context: CommandContext): void {
  context.logger.info(`DeepSeek: load the generated overlay with dsh --profile <profile> --patch ${DEEPSEEK_PATCH}. The profile needs @deepseek-ai/dsh-hooks-codex and @deepseek-ai/dsh-mcp-client matching its Harness version.`);
}

export function initDeepseekCommand(cli: CAC, context: CommandContext): void {
  cli.command('init-deepseek', 'Initialize DeepSeek Harness MemoryAnchor overlay')
    .action(async () => {
      const cwd = process.cwd();
      const common = await initPublic(cwd);
      const specific = await deepseekSetup(cwd);
      const mcpUpdated = await registerMcp(cwd, 'deepseek');
      const updated = mcpUpdated || common.gitignoreUpdated || common.anchorFilesCreated ||
        common.agentsCreated || specific.hooksUpdated || specific.patchUpdated;
      context.logger.info(updated
        ? 'Memory anchor configuration prepared for DeepSeek Harness in ./.memoryanchor/deepseek'
        : 'Memory anchor configuration for DeepSeek Harness already exists in ./.memoryanchor/deepseek');
      reportDeepseekSetup(context);
    });
}

/** Add only our command; never replace a user's matching entry or its policy. */
function addDeepseekHook(events: JsonObject, event: string, hook: JsonObject): void {
  const entries = events[event] ?? [];
  if (!Array.isArray(entries)) throw new Error(`Hook list ${event} must be an array.`);
  for (const entry of entries) {
    const group = asObject(entry, `${event} entry`);
    if (!Array.isArray(group.hooks)) throw new Error(`${event} hooks must be an array.`);
    if (group.hooks.some(value => {
      const existing = asObject(value, `${event} command`);
      return existing.command === hook.command && JSON.stringify(existing.args) === JSON.stringify(hook.args);
    })) return;
  }
  events[event] = [...entries, { hooks: [hook] }];
}
