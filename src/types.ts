import type { LANGS } from './constant.js';

// =============================================================================
// Language
// =============================================================================

export type Lang = typeof LANGS[number];

// =============================================================================
// Config
// =============================================================================

export type LogLevel = 'info' | 'warn' | 'error';

export interface AppConfig {
  dataDir: string;
  indexDir: string;
  logLevel: LogLevel;
}

// =============================================================================
// Command Context
// =============================================================================

export interface CommandContext {
  config: AppConfig;
  logger: import('./utils/logger.js').Logger;
}
