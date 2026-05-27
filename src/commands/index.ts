import type { CAC } from 'cac';
import type { CommandContext } from '../core/context';
import { initCommand } from './init';
import { statusCommand } from './status';

export function registerBuiltInCommands(cli: CAC, context: CommandContext): void {
  initCommand(cli, context);
  statusCommand(cli, context);
}
