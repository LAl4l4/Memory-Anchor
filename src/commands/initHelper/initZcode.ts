import { CAC } from 'cac';
import os from 'node:os';
import path from 'node:path';
import type { CommandContext } from '../../types.js';
import { HOOK_COMMANDS } from '../../constant.js';
import { initPublic } from './initPublic.js';
import { registerMcp } from './initMcp.js';
import { isPromptHookEnabled } from './promptHookConfig.js';
import { asObject, readConfig, saveConfig, type JsonObject } from './jsonConfig.js';

export interface ZcodeSetupResult {
  configUpdated: boolean;
}

export function zcodeConfigPath(): string {
  return path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

export async function hasZcodeHooks(): Promise<boolean> {
  try {
    const config = await readConfig(zcodeConfigPath());
    const hooks = asObject(config.hooks, 'hooks');
    const events = asObject(hooks.events, 'hooks.events');
    const commands: readonly string[] = [HOOK_COMMANDS.ZCODE_PRE, HOOK_COMMANDS.ZCODE_STOP, HOOK_COMMANDS.ZCODE_PROMPT];
    return Object.values(events).some(entries => Array.isArray(entries) && entries.some(entry => {
      const group = asObject(entry, 'hook group');
      return Array.isArray(group.hooks) && group.hooks.some(value =>
        commands.includes(String(asObject(value, 'hook command').command)));
    }));
  } catch { return false; }
}

async function ensureZcodeConfig(cwd: string): Promise<boolean> {
  const file = zcodeConfigPath();
  const config = await readConfig(file);
  const hooks = asObject(config.hooks ?? {}, 'hooks');
  const events = asObject(hooks.events ?? {}, 'hooks.events');
  config.hooks = hooks;
  hooks.events = events;
  // Project hooks are ignored by ZCode; preserve explicit user-level disabling.
  if (hooks.enabled === undefined) hooks.enabled = true;
  addZcodeHook(events, 'SessionStart', { type: 'process', command: HOOK_COMMANDS.ZCODE_PRE, args: [], timeoutMs: 10000 });
  addZcodeHook(events, 'Stop', { type: 'process', command: HOOK_COMMANDS.ZCODE_STOP, args: [], timeoutMs: 120000 });
  if (await isPromptHookEnabled(cwd, 'zcode')) {
    addZcodeHook(events, 'UserPromptSubmit', { type: 'process', command: HOOK_COMMANDS.ZCODE_PROMPT, args: [], timeoutMs: 10000 });
  }
  // Keep global dispatch for other projects; the wrapper checks workspace opt-in.
  return saveConfig(file, config);
}

export async function zcodeSetup(cwd: string): Promise<ZcodeSetupResult> {
  return { configUpdated: await ensureZcodeConfig(cwd) };
}

export function reportZcodeSetup(context: CommandContext): void {
  context.logger.info('ZCode: hooks use ~/.zcode/cli/config.json; start a new session. Existing disabled hook policies are preserved.');
}

export function initZcodeCommand(cli: CAC, context: CommandContext): void {
  cli.command('init-zcode', 'Initialize ZCode MemoryAnchor integration')
    .action(async () => {
      const cwd = process.cwd();
      const common = await initPublic(cwd);
      const specific = await zcodeSetup(cwd);
      const mcpUpdated = await registerMcp(cwd, 'zcode');
      const updated = mcpUpdated || common.gitignoreUpdated || common.anchorFilesCreated ||
        common.agentsCreated || specific.configUpdated;
      context.logger.info(updated
        ? 'Memory anchor initialized for ZCode'
        : 'Memory anchor for ZCode already exists');
      reportZcodeSetup(context);
    });
}

/** Add only our command; never replace a user's matching entry or its policy. */
function addZcodeHook(events: JsonObject, event: string, hook: JsonObject): void {
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
