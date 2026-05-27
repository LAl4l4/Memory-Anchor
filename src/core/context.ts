import type { AppConfig } from './config.js';
import type { Logger } from '../utils/logger.js';

export interface CommandContext {
  config: AppConfig;
  logger: Logger;
}
