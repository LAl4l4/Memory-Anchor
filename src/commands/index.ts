import type { App } from '../core/app.js';
import { initCommand } from './init.js';
import { statusCommand } from './status.js';

export function registerBuiltInCommands(app: App): void {
  app.registerCommand(initCommand());
  app.registerCommand(statusCommand());
}
