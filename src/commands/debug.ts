import type { CAC } from 'cac';
import type { CommandContext } from '../types.js';
import { setDebugMode } from '../utils/logger.js';

interface DebugOptions {
  off?: boolean;
}

/** Toggle persistent, workspace-local diagnostic logging for CLI and hooks. */
export function debugCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('debug', 'Enable persistent debug logs in .memoryanchor/debug.log')
    .option('--off', 'Disable persistent debug logging')
    .action((options: DebugOptions = {}) => {
      const cwd = process.cwd();
      const enabled = !options.off;
      setDebugMode(cwd, enabled);

      context.logger.info(
        enabled
          ? 'Memory Anchor debug logging enabled; logs will be appended to .memoryanchor/debug.log'
          : 'Memory Anchor debug logging disabled',
      );
    });
}
