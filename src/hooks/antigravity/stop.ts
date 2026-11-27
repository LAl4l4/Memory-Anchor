#!/usr/bin/env node
import { prepareAntigravityWorkspace, reportAntigravityHookError } from './hookInput.js';

try {
  if (await prepareAntigravityWorkspace()) {
    // A completion hook owns a short-lived process and must release its workers.
    const { runSessionEnd } = await import('../public/sessionEndPublic.js');
    await runSessionEnd({ exit: false });
  }
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
} catch (error) {
  reportAntigravityHookError('Stop', error);
}
