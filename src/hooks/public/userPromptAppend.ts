/** The instruction appended to every submitted user prompt. */
export const USER_PROMPT_APPENDIX =
  '[IMPORTANT!] Must read ./.memoryanchor/chart/.../chart.md before any works and glob/grep.';

/** Append the reminder exactly once, keeping it at the end of the prompt. */
export function appendUserPromptAppendix(prompt: string): string {
  if (prompt.includes(USER_PROMPT_APPENDIX)) {
    return prompt;
  }

  return `${prompt}\n\n${USER_PROMPT_APPENDIX}`;
}
