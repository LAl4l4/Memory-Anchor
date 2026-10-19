#!/usr/bin/env node
import { isPromptHookEnabled } from '../../commands/initHelper/promptHookConfig.js';
import { getUserPromptAppendix } from '../public/userPromptAppend.js';
import { prepareDeepseekWorkspace, reportDeepseekHookError } from './hookInput.js';

try {
  if (await prepareDeepseekWorkspace() && await isPromptHookEnabled(process.cwd(), 'deepseek')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: getUserPromptAppendix(),
      },
    }));
  }
} catch (error) {
  reportDeepseekHookError('UserPromptSubmit', error);
}
