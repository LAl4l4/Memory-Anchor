import { expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { USER_PROMPT_APPENDIX } from '../../dist/hooks/public/userPromptAppend.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');

function runHook(relativePath, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'dist', relativePath)]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Hook failed (${code}): ${stderr}`));
    });
    child.stdin.end(stdin);
  });
}

test('user-prompt hooks return a non-blocking tail reminder in each native protocol', async () => {
  expect(await runHook('hooks/claude/user-prompt.js')).toBe(USER_PROMPT_APPENDIX);

  for (const agent of ['codebuddy', 'qodercn']) {
    expect(JSON.parse(await runHook(`hooks/${agent}/user-prompt.js`))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: USER_PROMPT_APPENDIX,
      },
    });
  }

  expect(await runHook('hooks/codex/user-prompt.js')).toBe(USER_PROMPT_APPENDIX);
});

test('Copilot appends the reminder to the end of the transformed prompt exactly once', async () => {
  const input = JSON.stringify({ transformedPrompt: 'Please inspect this repository.' });
  const result = JSON.parse(await runHook('hooks/copilot/user-prompt.js', input));
  expect(result.modifiedTransformedPrompt).toBe(
    `Please inspect this repository.\n\n${USER_PROMPT_APPENDIX}`,
  );

  const repeated = JSON.parse(await runHook(
    'hooks/copilot/user-prompt.js',
    JSON.stringify({ transformedPrompt: result.modifiedTransformedPrompt }),
  ));
  expect(repeated.modifiedTransformedPrompt).toBe(result.modifiedTransformedPrompt);
});
