import cac from 'cac';
import { registerBuiltInCommands } from './commands/index';
import { createDefaultConfig } from './core/config';
import { logger } from './utils/logger';

export async function runCli(argv: string[]): Promise<void> {
  const cli = cac('memory-anchor');
  const context = { config: createDefaultConfig(), logger };

  const showScaffoldHelp = (withUsage: boolean): void => {
    context.logger.info('Memory Anchor CLI scaffold is ready.');
    context.logger.info('Use a built-in command once implemented.');
    if (withUsage) {
      cli.outputHelp();
    }
  };

  registerBuiltInCommands(cli, context);

  cli.command('', 'Show help').action(() => {
    showScaffoldHelp(false);
  });

  cli.command('help', 'Show help').action(() => {
    showScaffoldHelp(true);
  });

  cli.on('command:*', () => {
    throw new Error(`Unknown command: ${cli.args[0]}`);
  });

  cli.help();
  cli.parse(argv);
}
