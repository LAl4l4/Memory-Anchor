import type { CAC } from 'cac';
import type { CommandContext } from '../core/context.js';

export function statusCommand(cli: CAC, _context: CommandContext): void {
  cli.command('status', 'Show MemoryAnchor status').action(async () => {
    throw new Error('status command is not implemented yet.');
  });
}
