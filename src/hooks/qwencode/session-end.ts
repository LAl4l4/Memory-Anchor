#!/usr/bin/env node
import { prepareQwencodeWorkspace, reportQwencodeHookError } from './hookInput.js';

try {
  if (await prepareQwencodeWorkspace()) {
    // A completion hook owns a short-lived process and must release its workers.
    const { runSessionEnd } = await import('../public/sessionEndPublic.js');
    await runSessionEnd();
  }
} catch (error) {
  reportQwencodeHookError('SessionEnd', error);
}
