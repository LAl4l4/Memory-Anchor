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
}

interface UserMessage {
  id: string;
  sessionID: string;
}

interface MessagePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: unknown;
}

interface ChatMessageOutput {
  message: UserMessage;
  parts: MessagePart[];
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

const ANCHOR_DIR = path.join(process.cwd(), '.memoryanchor');
const INDEX_PATH = path.join(ANCHOR_DIR, 'index.md');
const ROOT_CHART_PATH = path.join(ANCHOR_DIR, 'chart', 'chart.md');
const BALLAST_PATH = path.join(ANCHOR_DIR, 'ballast.md');
const MANIFEST_PATH = path.join(ANCHOR_DIR, 'manifest.md');

function readFileSafe(filePath: string, fallback: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').trim() : fallback;
  } catch {
    return fallback;
  }
}

function buildMemoryCore(): string {
  const index = readFileSafe(INDEX_PATH, 'No project chart available.');
  const rootChart = fs.existsSync(ROOT_CHART_PATH) ? readFileSafe(ROOT_CHART_PATH, '') : '';
  const chart = rootChart
    ? '[INDEX ROUTING RULES — ALWAYS INJECTED]\n' +
      index +
      '\n\n[ROOT CHART ALREADY INJECTED — DO NOT READ IT AGAIN]\n' +
      rootChart
    : '[INDEX ROUTING RULES — ALWAYS INJECTED]\n' + index;
  const ballast = readFileSafe(
    BALLAST_PATH,
    'No active coding constraints or lessons-learned enforced.',
  );
  const manifest = readFileSafe(MANIFEST_PATH, 'No active cross-session tasks found.');
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

function isTextPartWithText(part: MessagePart): part is MessagePart & { text: string } {
  return part.type === 'text' && typeof part.text === 'string';
}

export const MemoryAnchorPlugin = async ({ $ }: PluginInput) => ({
  // System context can only be extended through this experimental hook.
  'experimental.chat.system.transform': async (
    _input: unknown,
    output: SystemTransformOutput,
  ): Promise<void> => {
    try {
      output.system.push(buildMemoryCore());
    } catch {
      // Hooks must never break the agent loop.
    }
  },

  // Reuse the final text part's OpenCode-generated ID rather than creating a
  // new part: plugin hooks cannot access the internal PartID allocator.
  'chat.message': async (_input: unknown, output: ChatMessageOutput): Promise<void> => {
    try {
      const textPart = [...output.parts].reverse().find(isTextPartWithText);
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
        await $`${HOOK_BIN}-stop`.quiet();
      }
      if (event.type === 'session.deleted') {
        await $`${HOOK_BIN}-post`.quiet();
      }
    } catch {
      // Hooks must never break the agent loop.
    }
  },
});
