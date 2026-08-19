import type { CAC } from 'cac';
import type { CommandContext } from '../types.js';
import { debugCommand } from './debug.js';
import { initCommand } from './init.js';
import { promptHookCommand } from './promptHook.js';
import { statusCommand } from './status.js';
import { versionCommand } from './version.js';

export function registerBuiltInCommands(cli: CAC, context: CommandContext): void {
  debugCommand(cli, context);
  versionCommand(cli, context);
  initCommand(cli, context);
  promptHookCommand(cli, context);
  statusCommand(cli, context);
}
