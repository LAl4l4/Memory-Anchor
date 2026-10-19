import { CAC } from 'cac';
import path from 'node:path';
import type { CommandContext } from '../../types.js';
import { AGENTS_ANCHOR_LINE, HOOK_COMMANDS } from '../../constant.js';
import { ensureFileWithAppend, initPublic } from './initPublic.js';
import { registerMcp } from './initMcp.js';
import { isPromptHookEnabled, removeNestedPromptHook } from './promptHookConfig.js';
import { asObject, readConfig, saveConfig, type JsonObject } from './jsonConfig.js';

export interface QwencodeSetupResult {
  settingsUpdated: boolean;
  qwenMdUpdated: boolean;
}

async function ensureQwencodeSettings(cwd: string): Promise<boolean> {
  const file = path.join(cwd, '.qwen', 'settings.json');
  const config = await readConfig(file);
  const hooks = asObject(config.hooks ?? {}, 'hooks');
  config.hooks = hooks;
  addQwencodeHook(hooks, 'SessionStart', { type: 'command', command: HOOK_COMMANDS.QWENCODE_PRE, timeout: 10 });
  addQwencodeHook(hooks, 'Stop', { type: 'command', command: HOOK_COMMANDS.QWENCODE_STOP, timeout: 120 });
  addQwencodeHook(hooks, 'SessionEnd', { type: 'command', command: HOOK_COMMANDS.QWENCODE_POST, timeout: 120 });
  if (await isPromptHookEnabled(cwd, 'qwencode')) {
    addQwencodeHook(hooks, 'UserPromptSubmit', { type: 'command', command: HOOK_COMMANDS.QWENCODE_PROMPT, timeout: 10 });
  } else {
    removeNestedPromptHook(hooks, 'UserPromptSubmit', HOOK_COMMANDS.QWENCODE_PROMPT);
  }
  return saveConfig(file, config);
}

export async function qwencodeSetup(cwd: string): Promise<QwencodeSetupResult> {
  const settingsUpdated = await ensureQwencodeSettings(cwd);
  const qwenMdUpdated = await ensureFileWithAppend(path.join(cwd, 'QWEN.md'), AGENTS_ANCHOR_LINE);
  return { settingsUpdated, qwenMdUpdated };
}

export function initQwencodeCommand(cli: CAC, context: CommandContext): void {
  cli.command('init-qwencode', 'Initialize Qwen Code MemoryAnchor workspace')
    .action(async () => {
      const cwd = process.cwd();
      const common = await initPublic(cwd);
      const specific = await qwencodeSetup(cwd);
      const mcpUpdated = await registerMcp(cwd, 'qwencode');
      const updated = mcpUpdated || common.gitignoreUpdated || common.anchorFilesCreated ||
        common.agentsCreated || specific.settingsUpdated || specific.qwenMdUpdated;
      context.logger.info(updated
        ? 'Memory anchor initialized for Qwen Code in ./.memoryanchor and ./.qwen'
        : 'Memory anchor for Qwen Code already exists in ./.memoryanchor and ./.qwen');
    });
}

/** Add only our command; never replace a user's matching entry or its policy. */
function addQwencodeHook(events: JsonObject, event: string, hook: JsonObject): void {
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
