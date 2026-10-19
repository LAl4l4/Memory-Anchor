#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';
import { prepareZcodeWorkspace, reportZcodeHookError } from './hookInput.js';

try {
  if (await prepareZcodeWorkspace()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: loadMemoryCore(),
      },
    }));
  }
} catch (error) {
  reportZcodeHookError('SessionStart', error);
}
