#!/usr/bin/env node
import { getUserPromptAppendix } from '../public/userPromptAppend.js';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: getUserPromptAppendix(),
    },
  }),
);
