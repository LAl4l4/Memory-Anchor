#!/usr/bin/env node
import { runCli } from './index.js';
import { appendDebugLog, formatError, logger } from './utils/logger.js';

runCli(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  appendDebugLog('debug', formatError(error));
  process.exitCode = 1;
});
