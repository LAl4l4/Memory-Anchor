#!/usr/bin/env node
import { appendUserPromptAppendix } from '../public/userPromptAppend.js';

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

try {
  const input = JSON.parse(await readStdin()) as CopilotPromptInput;
  if (typeof input.transformedPrompt === 'string') {
    process.stdout.write(
      JSON.stringify({
        modifiedTransformedPrompt: appendUserPromptAppendix(input.transformedPrompt),
      }),
    );
  } else {
    process.stdout.write('{}');
  }
} catch {
  // A malformed hook payload must not interfere with the user's prompt.
  process.stdout.write('{}');
}
