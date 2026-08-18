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
    try {
      output.system.push(buildMemoryCore(workspaceRoot));
    } catch {
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
    try {
      if (!isPromptHookEnabled(workspaceRoot)) return;
      const userMessage = [...output.messages]
        .reverse()
        .find((message) => message.info.role === 'user');
      if (!userMessage) return;

      const textPart = [...userMessage.parts].reverse().find(isTextPartWithText);
      if (!textPart || textPart.text.includes(USER_PROMPT_APPENDIX)) return;

      textPart.text = `${textPart.text}\n\n${USER_PROMPT_APPENDIX}`;
    } catch {
      // Hooks must never break the agent loop.
    }
  },

  // Runtime events are delivered through the generic `event` hook. The
  // lifecycle event names are values on the event payload, not hook keys.
  event: async ({ event }: EventOutput): Promise<void> => {
    try {
      if (event.type === 'session.idle') {
        await $`cd ${workspaceRoot} && ${HOOK_BIN}-stop`.quiet();
      }
      if (event.type === 'session.deleted') {
        await $`cd ${workspaceRoot} && ${HOOK_BIN}-post`.quiet();
      }
    } catch {
      // Hooks must never break the agent loop.
    }
  },
  };
};
