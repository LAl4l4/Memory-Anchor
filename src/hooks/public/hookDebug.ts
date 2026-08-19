import * as path from 'node:path';
import { appendDebugLog, formatError } from '../../utils/logger.js';

export type HookAgent =
  | 'claude'
  | 'codex'
  | 'codebuddy'
  | 'copilot'
  | 'opencode'
  | 'qodercn'
  | 'hermes'
  | 'unknown';

export interface HookInvocation {
  agent: HookAgent;
  event: string;
  workdir: string;
}

const AGENTS = new Set<HookAgent>([
  'claude',
  'codex',
  'codebuddy',
  'copilot',
  'opencode',
  'qodercn',
  'hermes',
]);

const EVENT_BY_ENTRY_FILE: Record<string, string> = {
  'session-start': 'SessionStart',
  'pre-session': 'SessionStart',
  'pre-llm-call': 'PreLlmCall',
  'user-prompt': 'UserPromptSubmit',
  stop: 'Stop',
  'agent-stop': 'Stop',
  'session-end': 'SessionEnd',
  'post-session': 'SessionEnd',
};

/** Package-bin names remain available when Node is invoked through a symlink. */
const INVOCATION_BY_BIN_NAME: Record<string, Pick<HookInvocation, 'agent' | 'event'>> = {
  'memoryanchor-claude-pre': { agent: 'claude', event: 'SessionStart' },
  'memoryanchor-claude-stop': { agent: 'claude', event: 'Stop' },
  'memoryanchor-claude-post': { agent: 'claude', event: 'SessionEnd' },
  'memoryanchor-claude-prompt': { agent: 'claude', event: 'UserPromptSubmit' },
  'memoryanchor-copilot-pre': { agent: 'copilot', event: 'SessionStart' },
  'memoryanchor-copilot-stop': { agent: 'copilot', event: 'Stop' },
  'memoryanchor-copilot-post': { agent: 'copilot', event: 'SessionEnd' },
  'memoryanchor-copilot-prompt': { agent: 'copilot', event: 'UserPromptSubmit' },
  'memoryanchor-codex-pre': { agent: 'codex', event: 'SessionStart' },
  'memoryanchor-codex-stop': { agent: 'codex', event: 'Stop' },
  'memoryanchor-codex-prompt': { agent: 'codex', event: 'UserPromptSubmit' },
  'memoryanchor-codebuddy-pre': { agent: 'codebuddy', event: 'SessionStart' },
  'memoryanchor-codebuddy-stop': { agent: 'codebuddy', event: 'Stop' },
  'memoryanchor-codebuddy-post': { agent: 'codebuddy', event: 'SessionEnd' },
  'memoryanchor-codebuddy-prompt': { agent: 'codebuddy', event: 'UserPromptSubmit' },
  'memoryanchor-qodercn-pre': { agent: 'qodercn', event: 'SessionStart' },
  'memoryanchor-qodercn-stop': { agent: 'qodercn', event: 'Stop' },
  'memoryanchor-qodercn-post': { agent: 'qodercn', event: 'SessionEnd' },
  'memoryanchor-qodercn-prompt': { agent: 'qodercn', event: 'UserPromptSubmit' },
  'memoryanchor-hermes-pre': { agent: 'hermes', event: 'PreLlmCall' },
  'memoryanchor-hermes-stop': { agent: 'hermes', event: 'Stop' },
  'memoryanchor-hermes-post': { agent: 'hermes', event: 'SessionEnd' },
  'memoryanchor-hermes-prompt': { agent: 'hermes', event: 'UserPromptSubmit' },
  'memoryanchor-opencode-stop': { agent: 'opencode', event: 'session.idle' },
  'memoryanchor-opencode-post': { agent: 'opencode', event: 'session.deleted' },
};

/** Infer a native hook's platform and lifecycle event from its executable path. */
export function getHookInvocation(
  entryPath: string = process.argv[1] ?? '',
  workdir: string = process.cwd(),
): HookInvocation {
  const normalizedPath = entryPath.split(/[\\/]/).join('/');
  const agentName = path.posix.basename(path.posix.dirname(normalizedPath));
  const entryName = path.posix.basename(normalizedPath).replace(/\.[^.]+$/, '');
  const binInvocation = INVOCATION_BY_BIN_NAME[entryName];
  if (binInvocation) {
    return { ...binInvocation, workdir: path.resolve(workdir) };
  }
  const agent = AGENTS.has(agentName as HookAgent)
    ? agentName as HookAgent
    : 'unknown';

  return {
    agent,
    event: EVENT_BY_ENTRY_FILE[entryName] ?? (entryName || 'Unknown'),
    workdir: path.resolve(workdir),
  };
}

export function logHookTriggered(invocation: HookInvocation = getHookInvocation()): HookInvocation {
  appendDebugLog(
    'debug',
    `Hook triggered | agent=${invocation.agent} | event=${invocation.event} | workdir=${invocation.workdir}`,
    invocation.workdir,
  );
  return invocation;
}

export function logHookSucceeded(invocation: HookInvocation, result: string): void {
  appendDebugLog(
    'debug',
    `Hook result | agent=${invocation.agent} | event=${invocation.event} | workdir=${invocation.workdir} | status=success | result=${result}`,
    invocation.workdir,
  );
}

export function logHookFailed(invocation: HookInvocation, error: unknown): void {
  appendDebugLog(
    'error',
    `Hook result | agent=${invocation.agent} | event=${invocation.event} | workdir=${invocation.workdir} | status=failed\n${formatError(error)}`,
    invocation.workdir,
  );
}
