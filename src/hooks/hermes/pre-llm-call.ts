#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';
import { isMemoryAnchorWorkspace } from './workspaceGuard.js';

interface PreLlmCallResponse {
  context: string;
}

try {
  if (!isMemoryAnchorWorkspace()) {
    process.stdout.write('{}');
    process.exit(0);
  }

  const payload: PreLlmCallResponse = {
    context: loadMemoryCore(),
  };
  process.stdout.write(JSON.stringify(payload));
} catch (err) {
  process.stdout.write('{}');
}
process.exit(0);