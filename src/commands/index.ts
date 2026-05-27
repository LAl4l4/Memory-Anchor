import type { CAC } from 'cac';
import type { CommandContext } from '../core/context.js';
import { initCommand } from './init.js';
import { statusCommand } from './status.js';

export function registerBuiltInCommands(cli: CAC, context: CommandContext): void {
  initCommand(cli, context);
  statusCommand(cli, context);
}
