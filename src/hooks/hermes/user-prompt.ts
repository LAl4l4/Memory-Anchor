#!/usr/bin/env node
import { appendUserPromptAppendix } from '../public/userPromptAppend.js';
import { isMemoryAnchorWorkspace } from './workspaceGuard.js';

interface PreLlmCallContext {
  context: string;
}

try {
  if (!isMemoryAnchorWorkspace()) {
    process.stdout.write('{}');
    process.exit(0);
  }

  const payload: PreLlmCallContext = {
    context: appendUserPromptAppendix(''),
  };
  process.stdout.write(JSON.stringify(payload));
} catch (err) {
  process.stdout.write('{}');
}
process.exit(0);