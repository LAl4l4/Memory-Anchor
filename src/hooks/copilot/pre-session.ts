#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';

interface SessionStartResponse {
  additionalContext: string;
}

try {
  const payload: SessionStartResponse = {
    additionalContext: loadMemoryCore(),
  };
  process.stdout.write(JSON.stringify(payload));
} catch (err) {
  const fallback: SessionStartResponse = { additionalContext: '' };
  process.stdout.write(JSON.stringify(fallback));
}
process.exit(0);
