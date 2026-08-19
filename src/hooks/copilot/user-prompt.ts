#!/usr/bin/env node
import { appendUserPromptAppendix } from '../public/userPromptAppend.js';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from '../public/hookDebug.js';

interface CopilotPromptInput {
  transformedPrompt?: unknown;
}

async function readStdin(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

const invocation = logHookTriggered(getHookInvocation());

try {
  const input = JSON.parse(await readStdin()) as CopilotPromptInput;
  if (typeof input.transformedPrompt === 'string') {
    process.stdout.write(
      JSON.stringify({
        modifiedTransformedPrompt: appendUserPromptAppendix(input.transformedPrompt, invocation),
      }),
    );
  } else {
    process.stdout.write('{}');
    logHookSucceeded(invocation, 'skipped: transformedPrompt is not a string');
  }
} catch (error) {
  // A malformed hook payload must not interfere with the user's prompt.
  process.stdout.write('{}');
  logHookFailed(invocation, error);
}
