#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';
import { prepareAntigravityWorkspace, reportAntigravityHookError } from './hookInput.js';

try {
  if (await prepareAntigravityWorkspace()) {
    process.stdout.write(JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: loadMemoryCore(),
          },
        },
      ],
    }));
  } else {
    process.stdout.write('{}');
  }
} catch (error) {
  reportAntigravityHookError('SessionStart', error);
}
