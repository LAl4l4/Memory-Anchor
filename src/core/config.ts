export type LogLevel = 'info' | 'warn' | 'error';

export interface AppConfig {
  dataDir: string;
  indexDir: string;
  logLevel: LogLevel;
}

export function createDefaultConfig(): AppConfig {
  return {
    dataDir: '.copilotwolf',
    indexDir: '.copilotwolf/index',
    logLevel: 'info'
  };
}
