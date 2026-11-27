#!/usr/bin/env node
import { isPromptHookEnabled } from '../../commands/initHelper/promptHookConfig.js';
import { getUserPromptAppendix } from '../public/userPromptAppend.js';
import { prepareAntigravityWorkspace, reportAntigravityHookError } from './hookInput.js';

try {
  if (await prepareAntigravityWorkspace() && await isPromptHookEnabled(process.cwd(), 'antigravity')) {
    process.stdout.write(JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: getUserPromptAppendix(),
          },
        },
      ],
    }));
  } else {
    process.stdout.write('{}');
  }
} catch (error) {
  reportAntigravityHookError('PreInvocation', error);
}
