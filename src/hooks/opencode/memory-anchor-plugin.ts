// This module is compiled by tsc and copied verbatim to
// .opencode/plugins/memory-anchor.js by init-opencode.
import * as fs from 'node:fs';
import * as path from 'node:path';

interface QuietCommand {
  quiet(): Promise<unknown>;
}

type BunShell = (strings: TemplateStringsArray, ...values: unknown[]) => QuietCommand;

interface PluginInput {
  $: BunShell;
  directory?: string;
  worktree?: string | null;
}

interface MessagePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: unknown;
}

interface MessageInfo {
  role: string;
}

interface ChatMessagesTransformOutput {
  messages: Array<{
    info: MessageInfo;
    parts: MessagePart[];
  }>;
}

interface SystemTransformOutput {
  system: string[];
}

interface RuntimeEvent {
  type: string;
}

interface EventOutput {
  event: RuntimeEvent;
}

// This file is copied as a standalone plugin, so it cannot import the CLI's
// HOOK_COMMANDS constant. Keep the public bin name in sync with it.
const HOOK_BIN = 'memoryanchor-opencode';
const USER_PROMPT_APPENDIX =
  '[IMPORTANT!] Must read ./.memoryanchor/chart/.../chart.md before any works and glob/grep.';

type DebugLogLevel = 'debug' | 'error';

function isDebugModeEnabled(workspaceRoot: string): boolean {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, '.memoryanchor', 'debug.json'), 'utf8'),
    ) as { enabled?: unknown };
    return config.enabled === true;
  } catch {
    return false;
  }
}

function appendDebugLog(workspaceRoot: string, level: DebugLogLevel, message: string): void {
  if (!isDebugModeEnabled(workspaceRoot)) return;
  try {
    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}] `;
    const lines = message.replace(/\r\n/g, '\n').split('\n');
    fs.appendFileSync(
      path.join(workspaceRoot, '.memoryanchor', 'debug.log'),
      `${lines.map((line) => `${prefix}${line}`).join('\n')}\n`,
      'utf8',
    );
  } catch {
    // OpenCode diagnostics must not interfere with the agent loop.
  }
}

function logHookTriggered(workspaceRoot: string, event: string): void {
  appendDebugLog(
    workspaceRoot,
    'debug',
    `Hook triggered | agent=opencode | event=${event} | workdir=${workspaceRoot}`,
  );
}

function logHookSucceeded(workspaceRoot: string, event: string, result: string): void {
  appendDebugLog(
    workspaceRoot,
    'debug',
    `Hook result | agent=opencode | event=${event} | workdir=${workspaceRoot} | status=success | result=${result}`,
  );
}

function logHookFailed(workspaceRoot: string, event: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  appendDebugLog(
    workspaceRoot,
    'error',
    `Hook result | agent=opencode | event=${event} | workdir=${workspaceRoot} | status=failed\n${detail}`,
  );
}

function readFileSafe(filePath: string, fallback: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').trim() : fallback;
  } catch {
    return fallback;
  }
}

function resolveWorkspaceRoot(directory?: string, worktree?: string | null): string {
  const candidates = [worktree, directory, process.cwd()]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate));
  const anchoredRoot = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, '.memoryanchor')),
  );
  return anchoredRoot ?? path.resolve(directory ?? worktree ?? process.cwd());
}

function buildMemoryCore(workspaceRoot: string): string {
  const anchorDir = path.join(workspaceRoot, '.memoryanchor');
  const indexPath = path.join(anchorDir, 'index.md');
  const rootChartPath = path.join(anchorDir, 'chart', 'chart.md');
  const ballastPath = path.join(anchorDir, 'ballast.md');
  const manifestPath = path.join(anchorDir, 'manifest.md');
  const index = readFileSafe(indexPath, 'No project chart available.');
  const rootChart = fs.existsSync(rootChartPath) ? readFileSafe(rootChartPath, '') : '';
  const chart = rootChart
    ? '[INDEX ROUTING RULES — ALWAYS INJECTED]\n' +
      index +
      '\n\n[ROOT CHART ALREADY INJECTED — DO NOT READ IT AGAIN]\n' +
      rootChart
    : '[INDEX ROUTING RULES — ALWAYS INJECTED]\n' + index;
  const ballast = readFileSafe(
    ballastPath,
    'No active coding constraints or lessons-learned enforced.',
  );
  const manifest = readFileSafe(manifestPath, 'No active cross-session tasks found.');
  const taskSection = ballast.includes('[STALE]')
    ? "\n[TRIGGERED MISSION: MEMORY PRUNING]\n- Urgent Status: Some developer-enforced limits inside the [2. BALLAST RULES] section are currently flagged with '[STALE]'.\n- Your Action Required: These rules are likely obsolete due to recent code changes. You MUST evaluate and directly rewrite '.memoryanchor/ballast.md' to DELETE any invalid stale rules during this session.\n"
    : '';

  return [
    '==================================================',
    '[MEMORY ANCHOR: CONTEXT INJECTED]',
    'Target: Assist the developer by ensuring all generated code aligns with local repository constraints.',
    '',
    taskSection,
    '[1. CHART (project structure & architectural symbols)]',
    chart,
    '',
    '[2. BALLAST (rules must follow)]',
    ballast,
    '',
    '[3. MANIFEST (module status & key decisions)]',
    manifest,
    '==================================================',
  ].join('\n');
}

function isPromptHookEnabled(workspaceRoot: string): boolean {
  try {
    const configPath = path.join(workspaceRoot, '.memoryanchor', 'prompt-hooks.json');
    const config = JSON.parse(readFileSafe(configPath, '{}')) as {
      enabled?: unknown;
    };
    return Array.isArray(config.enabled) && config.enabled.includes('opencode');
  } catch {
    return false;
  }
}

function isTextPartWithText(part: MessagePart): part is MessagePart & { text: string } {
  return part.type === 'text' && typeof part.text === 'string';
}

export const MemoryAnchorPlugin = async ({ $, directory, worktree }: PluginInput) => {
  const workspaceRoot = resolveWorkspaceRoot(directory, worktree);

  return {
  // System context can only be extended through this experimental hook.
  'experimental.chat.system.transform': async (
    _input: unknown,
    output: SystemTransformOutput,
  ): Promise<void> => {
    const event = 'experimental.chat.system.transform';
    logHookTriggered(workspaceRoot, event);
    try {
      const memoryCore = buildMemoryCore(workspaceRoot);
      output.system.push(memoryCore);
      logHookSucceeded(workspaceRoot, event, `memory context injected (${memoryCore.length} chars)`);
    } catch (error) {
      logHookFailed(workspaceRoot, event, error);
      // Hooks must never break the agent loop.
    }
  },

  // Add the optional reminder to the outbound message copy. This transform
  // runs after the user message has been assembled but before it is converted
  // into provider messages, so the persisted user message stays untouched.
  'experimental.chat.messages.transform': async (
    _input: unknown,
    output: ChatMessagesTransformOutput,
  ): Promise<void> => {
    const event = 'experimental.chat.messages.transform';
    logHookTriggered(workspaceRoot, event);
    try {
      if (!isPromptHookEnabled(workspaceRoot)) {
        logHookSucceeded(workspaceRoot, event, 'skipped: UserPrompt hook disabled');
        return;
      }
      const userMessage = [...output.messages]
        .reverse()
        .find((message) => message.info.role === 'user');
      if (!userMessage) {
        logHookSucceeded(workspaceRoot, event, 'skipped: no user message');
        return;
      }

      const textPart = [...userMessage.parts].reverse().find(isTextPartWithText);
      if (!textPart) {
        logHookSucceeded(workspaceRoot, event, 'skipped: no text message part');
        return;
      }
      if (textPart.text.includes(USER_PROMPT_APPENDIX)) {
        logHookSucceeded(workspaceRoot, event, 'skipped: prompt already contains the reminder');
        return;
      }

      textPart.text = `${textPart.text}\n\n${USER_PROMPT_APPENDIX}`;
      logHookSucceeded(workspaceRoot, event, 'prompt reminder appended');
    } catch (error) {
      logHookFailed(workspaceRoot, event, error);
      // Hooks must never break the agent loop.
    }
  },

  // Runtime events are delivered through the generic `event` hook. The
  // lifecycle event names are values on the event payload, not hook keys.
  event: async ({ event }: EventOutput): Promise<void> => {
    if (event.type !== 'session.idle' && event.type !== 'session.deleted') return;
    logHookTriggered(workspaceRoot, event.type);
    try {
      if (event.type === 'session.idle') {
        await $`cd ${workspaceRoot} && ${HOOK_BIN}-stop`.quiet();
        logHookSucceeded(workspaceRoot, event.type, `executed ${HOOK_BIN}-stop`);
      }
      if (event.type === 'session.deleted') {
        await $`cd ${workspaceRoot} && ${HOOK_BIN}-post`.quiet();
        logHookSucceeded(workspaceRoot, event.type, `executed ${HOOK_BIN}-post`);
      }
    } catch (error) {
      logHookFailed(workspaceRoot, event.type, error);
      // Hooks must never break the agent loop.
    }
  },
  };
};
