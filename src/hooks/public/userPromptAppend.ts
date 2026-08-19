import {
  getHookInvocation,
  logHookSucceeded,
  logHookTriggered,
  type HookInvocation,
} from './hookDebug.js';

/** The instruction appended to every submitted user prompt. */
export const USER_PROMPT_APPENDIX =
  '[IMPORTANT!] Must read ./.memoryanchor/chart/.../chart.md before any works and glob/grep.';

/** Return the prompt reminder while recording the native hook result. */
export function getUserPromptAppendix(): string {
  const invocation = logHookTriggered(getHookInvocation());
  logHookSucceeded(invocation, 'prompt reminder supplied');
  return USER_PROMPT_APPENDIX;
}

/** Append the reminder exactly once, keeping it at the end of the prompt. */
export function appendUserPromptAppendix(
  prompt: string,
  invocation: HookInvocation = logHookTriggered(getHookInvocation()),
): string {
  if (prompt.includes(USER_PROMPT_APPENDIX)) {
    logHookSucceeded(invocation, 'skipped: prompt already contains the reminder');
    return prompt;
  }

  logHookSucceeded(invocation, 'prompt reminder appended');
  return `${prompt}\n\n${USER_PROMPT_APPENDIX}`;
}
