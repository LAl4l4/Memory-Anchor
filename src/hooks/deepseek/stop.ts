#!/usr/bin/env node
import { prepareDeepseekWorkspace, reportDeepseekHookError } from './hookInput.js';

try {
  if (await prepareDeepseekWorkspace()) {
    // A completion hook owns a short-lived process and must release its workers.
    const { runSessionEnd } = await import('../public/sessionEndPublic.js');
    await runSessionEnd();
  }
} catch (error) {
  reportDeepseekHookError('Stop', error);
}
