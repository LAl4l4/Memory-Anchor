import type { AppConfig } from './config';
import type { Logger } from '../utils/logger';

export interface CommandContext {
  config: AppConfig;
  logger: Logger;
}
