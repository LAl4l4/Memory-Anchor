import type { Command } from '../core/app.js';

export function statusCommand(): Command {
  return {
    name: 'status',
    description: 'Show CopilotWolf status',
    async run(_args, _context) {
      throw new Error('status command is not implemented yet.');
    }
  };
}
