#!/usr/bin/env node
import { isPromptHookEnabled } from '../../commands/initHelper/promptHookConfig.js';
import { getUserPromptAppendix } from '../public/userPromptAppend.js';
import { prepareZcodeWorkspace, reportZcodeHookError } from './hookInput.js';

try {
  if (await prepareZcodeWorkspace() && await isPromptHookEnabled(process.cwd(), 'zcode')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: getUserPromptAppendix(),
      },
    }));
  }
} catch (error) {
  reportZcodeHookError('UserPromptSubmit', error);
}
