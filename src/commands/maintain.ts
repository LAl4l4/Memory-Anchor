import type { CAC } from 'cac';
import type { CommandContext } from '../types.js';
import { readMemoryMaintenanceNotice } from '../hooks/public/memoryMaintenance.js';
import { sanitizeGuardrails } from '../hooks/public/guardrailMaintenance.js';

export function maintainCommand(cli: CAC, context: CommandContext): void {
  cli.command('maintain', 'Review memory budgets and legacy stale-rule markers')
    .option('--normalize', 'Normalize guardrail formatting without evaluating rule validity')
    .action((options: { normalize?: boolean }) => {
      if (options.normalize) sanitizeGuardrails(process.cwd());
      context.logger.info(readMemoryMaintenanceNotice(process.cwd()) || 'No memory maintenance notices.');
    });
}
