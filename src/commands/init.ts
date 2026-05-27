import type { Command } from '../core/app.js';

export function initCommand(): Command {
  return {
    name: 'init',
    description: 'Initialize CopilotWolf workspace',
    async run(_args, _context) {
      throw new Error('init command is not implemented yet.');
    }
  };
}
