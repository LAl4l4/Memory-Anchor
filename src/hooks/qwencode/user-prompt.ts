#!/usr/bin/env node
import { isPromptHookEnabled } from '../../commands/initHelper/promptHookConfig.js';
import { getUserPromptAppendix } from '../public/userPromptAppend.js';
import { prepareQwencodeWorkspace, reportQwencodeHookError } from './hookInput.js';

try {
  if (await prepareQwencodeWorkspace() && await isPromptHookEnabled(process.cwd(), 'qwencode')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: getUserPromptAppendix(),
      },
    }));
  }
} catch (error) {
  reportQwencodeHookError('UserPromptSubmit', error);
}
