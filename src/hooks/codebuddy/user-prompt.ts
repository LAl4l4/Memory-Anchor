#!/usr/bin/env node
import { USER_PROMPT_APPENDIX } from '../public/userPromptAppend.js';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: USER_PROMPT_APPENDIX,
    },
  }),
);
