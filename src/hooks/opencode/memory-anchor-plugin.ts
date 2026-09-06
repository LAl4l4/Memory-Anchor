// This module and its shared imports are bundled at build time and copied to
// .opencode/plugins/memory-anchor.js by init-opencode.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildMemoryCore } from '../public/memoryCore.js';
import { logHookTriggered, logHookSucceeded, logHookFailed } from '../public/hookDebug.js';
import { USER_PROMPT_APPENDIX } from '../public/userPromptAppend.js';
import { HOOK_COMMANDS } from '../../constant.js';

const HOOK_BIN = HOOK_COMMANDS.OPENCODE;

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

function resolveWorkspaceRoot(directory?: string, worktree?: string | null): string {
  const candidates = [worktree, directory, process.cwd()]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate));
  const anchoredRoot = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, '.memoryanchor')),
  );
  return anchoredRoot ?? path.resolve(directory ?? worktree ?? process.cwd());
}

function isPromptHookEnabled(workspaceRoot: string): boolean {
  try {
    const configPath = path.join(workspaceRoot, '.memoryanchor', 'prompt-hooks.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
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
    logHookTriggered({ agent: 'opencode', event, workdir: workspaceRoot });
    try {
      const memoryCore = buildMemoryCore(workspaceRoot);
      output.system.push(memoryCore);
      logHookSucceeded({ agent: 'opencode', event, workdir: workspaceRoot }, `memory context injected (${memoryCore.length} chars)`);
    } catch (error) {
      logHookFailed({ agent: 'opencode', event, workdir: workspaceRoot }, error);
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
    logHookTriggered({ agent: 'opencode', event, workdir: workspaceRoot });
    try {
      if (!isPromptHookEnabled(workspaceRoot)) {
        logHookSucceeded({ agent: 'opencode', event, workdir: workspaceRoot }, 'skipped: UserPrompt hook disabled');
        return;
      }
      const userMessage = [...output.messages]
        .reverse()
        .find((message) => message.info.role === 'user');
      if (!userMessage) {
        logHookSucceeded({ agent: 'opencode', event, workdir: workspaceRoot }, 'skipped: no user message');
        return;
      }

      const textPart = [...userMessage.parts].reverse().find(isTextPartWithText);
      if (!textPart) {
        logHookSucceeded({ agent: 'opencode', event, workdir: workspaceRoot }, 'skipped: no text message part');
        return;
      }
      if (textPart.text.includes(USER_PROMPT_APPENDIX)) {
        logHookSucceeded({ agent: 'opencode', event, workdir: workspaceRoot }, 'skipped: prompt already contains the reminder');
        return;
      }

      textPart.text = `${textPart.text}\n\n${USER_PROMPT_APPENDIX}`;
      logHookSucceeded({ agent: 'opencode', event, workdir: workspaceRoot }, 'prompt reminder appended');
    } catch (error) {
      logHookFailed({ agent: 'opencode', event, workdir: workspaceRoot }, error);
      // Hooks must never break the agent loop.
    }
  },

  // Runtime events are delivered through the generic `event` hook. The
  // lifecycle event names are values on the event payload, not hook keys.
  event: async ({ event }: EventOutput): Promise<void> => {
    // OpenCode emits `session.deleted` only when the user deletes a stored
    // session. Its v1 plugin event stream has no CLI/application-shutdown
    // event, so use `session.idle` as the Codex-style fallback for session-end
    // maintenance instead.
    if (event.type !== 'session.idle') return;
    logHookTriggered({ agent: 'opencode', event: event.type, workdir: workspaceRoot });
    try {
      await $`cd ${workspaceRoot} && ${HOOK_BIN}-post`.quiet();
      logHookSucceeded({ agent: 'opencode', event: event.type, workdir: workspaceRoot }, `executed ${HOOK_BIN}-post`);
    } catch (error) {
      logHookFailed({ agent: 'opencode', event: event.type, workdir: workspaceRoot }, error);
      // Hooks must never break the agent loop.
    }
  },
  };
};
