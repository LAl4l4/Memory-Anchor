import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ANCHOR_DIR_NAME,
  DEBUG_CONFIG_FILE_NAME,
  DEBUG_LOG_FILE_NAME,
} from '../constant.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface DebugConfig {
  enabled?: unknown;
}

function getAnchorDirectory(cwd: string): string {
  return path.join(cwd, ANCHOR_DIR_NAME);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Return the workspace-local file that persists debug-mode selection. */
export function getDebugConfigPath(cwd: string = process.cwd()): string {
  return path.join(getAnchorDirectory(cwd), DEBUG_CONFIG_FILE_NAME);
}

/** Return the append-only diagnostic log path for a workspace. */
export function getDebugLogPath(cwd: string = process.cwd()): string {
  return path.join(getAnchorDirectory(cwd), DEBUG_LOG_FILE_NAME);
}

export function isDebugModeEnabled(cwd: string = process.cwd()): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(getDebugConfigPath(cwd), 'utf8')) as DebugConfig;
    return config.enabled === true;
  } catch {
    return false;
  }
}

/** Persist the opt-in flag without altering any existing diagnostic log. */
export function setDebugMode(cwd: string, enabled: boolean): string {
  const anchorDirectory = getAnchorDirectory(cwd);
  fs.mkdirSync(anchorDirectory, { recursive: true });
  fs.writeFileSync(
    getDebugConfigPath(cwd),
    `${JSON.stringify({ enabled }, null, 2)}\n`,
    'utf8',
  );
  return getDebugLogPath(cwd);
}

/**
 * Append a diagnostic only while the workspace has explicitly enabled debug
 * mode. Logging must never interfere with chart generation or hook handling.
 */
export function appendDebugLog(
  level: DebugLogLevel,
  message: string,
  cwd: string = process.cwd(),
): void {
  if (!isDebugModeEnabled(cwd)) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] `;
  const lines = stripAnsi(message)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line, index, all) => line.length > 0 || index < all.length - 1);

  try {
    fs.appendFileSync(
      getDebugLogPath(cwd),
      `${lines.map(line => `${prefix}${line}`).join('\n')}\n`,
      'utf8',
    );
  } catch {
    // Debug instrumentation is strictly best-effort.
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

export const logger: Logger = {
  info(message) {
    console.log(message);
    appendDebugLog('info', message);
  },
  warn(message) {
    console.warn(message);
    appendDebugLog('warn', message);
  },
  error(message) {
    console.error(message);
    appendDebugLog('error', message);
  }
};
