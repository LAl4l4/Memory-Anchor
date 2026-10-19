#!/usr/bin/env node
import { prepareZcodeWorkspace, reportZcodeHookError } from './hookInput.js';

try {
  if (await prepareZcodeWorkspace()) {
    // A completion hook owns a short-lived process and must release its workers.
    const { runSessionEnd } = await import('../public/sessionEndPublic.js');
    await runSessionEnd();
  }
} catch (error) {
  reportZcodeHookError('Stop', error);
}
