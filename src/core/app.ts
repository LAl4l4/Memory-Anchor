import { createDefaultConfig, type AppConfig } from './config.js';
import { logger, type Logger } from '../utils/logger.js';

export interface CommandContext {
  config: AppConfig;
  logger: Logger;
}

export interface Command {
  name: string;
  description?: string;
  run(args: string[], context: CommandContext): Promise<void> | void;
}

export interface App {
  config: AppConfig;
  registerCommand(command: Command): void;
  run(argv: string[]): Promise<void>;
}

export function createApp(): App {
  const commands = new Map<string, Command>();
  const config = createDefaultConfig();

  return {
    config,
    registerCommand(command) {
      commands.set(command.name, command);
    },
    async run(argv) {
      const [, , commandName = 'help', ...rest] = argv;

      if (commandName === 'help') {
        logger.info('CopilotWolf CLI scaffold is ready.');
        logger.info('Use a built-in command once implemented.');
        return;
      }

      const command = commands.get(commandName);
      if (!command) {
        throw new Error(`Unknown command: ${commandName}`);
      }

      await command.run(rest, { config, logger });
    }
  };
}
