#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';
import { prepareQwencodeWorkspace, reportQwencodeHookError } from './hookInput.js';

try {
  if (await prepareQwencodeWorkspace()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: loadMemoryCore(),
      },
    }));
  }
} catch (error) {
  reportQwencodeHookError('SessionStart', error);
}
