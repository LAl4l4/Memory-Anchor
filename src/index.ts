import { createApp } from './core/app.js';
import { registerBuiltInCommands } from './commands/index.js';

export async function runCli(argv: string[]): Promise<void> {
  const app = createApp();
  registerBuiltInCommands(app);
  await app.run(argv);
}
