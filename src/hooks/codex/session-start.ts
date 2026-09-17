#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';

try {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: loadMemoryCore(),
    },
  }));
} catch (err) {
  process.stdout.write(JSON.stringify({ systemMessage: 'Failed to load memory.' }));
}
