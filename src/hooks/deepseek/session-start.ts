#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';
import { prepareDeepseekWorkspace, reportDeepseekHookError } from './hookInput.js';

try {
  if (await prepareDeepseekWorkspace()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: loadMemoryCore(),
      },
    }));
  }
} catch (error) {
  reportDeepseekHookError('SessionStart', error);
}
