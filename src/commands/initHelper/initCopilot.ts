import { CAC } from 'cac';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import type { CommandContext } from '../../types.js';
import { AGENTS_ANCHOR_LINE, HOOK_COMMANDS } from '../../constant.js';
import {
  type HookCommand,
  type BasePaths,
  getBasePaths,
  initPublic,
  fileExists,
  readJsonFile,
  writeJsonFile,
  fileContainsLine,
} from './initPublic.js';

// =============================================================================
// Copilot-Specific Types
// =============================================================================

interface CopilotHooksConfig {
  version?: number;
  hooks?: {
    sessionStart?: HookCommand[];
    sessionEnd?: HookCommand[];
    agentStop?: HookCommand[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface CopilotPaths extends BasePaths {
  hooksDir: string;
  hookPath: string;
  copilotInstructionsPath: string;
}

export interface CopilotSetupResult {
  hooksUpdated: boolean;
  instructionsUpdated: boolean;
}

// =============================================================================
// Copilot-Specific Constants
// =============================================================================

const COPILOT_REQUIRED_HOOKS: Record<'sessionStart' | 'sessionEnd' | 'agentStop', HookCommand> = {
  sessionStart: {
    type: 'command',
    bash: HOOK_COMMANDS.COPILOT_PRE,
    powershell: HOOK_COMMANDS.COPILOT_PRE,
    timeoutSec: 10,
  },
  agentStop: {
    type: 'command',
    bash: HOOK_COMMANDS.COPILOT_STOP,
    powershell: HOOK_COMMANDS.COPILOT_STOP,
    timeoutSec: 10,
  },
  sessionEnd: {
    type: 'command',
    bash: HOOK_COMMANDS.COPILOT_POST,
    powershell: HOOK_COMMANDS.COPILOT_POST,
    timeoutSec: 10,
  },
};

// =============================================================================
// Copilot Paths
// =============================================================================

function getCopilotPaths(cwd: string): CopilotPaths {
  const base = getBasePaths(cwd);
  const hooksDir = path.join(cwd, '.github', 'hooks');

  return {
    ...base,
    hooksDir,
    hookPath: path.join(hooksDir, 'memory-anchor.json'),
    copilotInstructionsPath: path.join(cwd, '.github', 'copilot-instructions.md'),
  };
}

// =============================================================================
// Hooks Config (Copilot format: .github/hooks/memory-anchor.json)
// =============================================================================

async function ensureHookConfig(paths: CopilotPaths): Promise<boolean> {
  const exists = await fileExists(paths.hookPath);
  if (!exists) {
    const config: CopilotHooksConfig = {
      version: 1,
      hooks: {
        sessionStart: [COPILOT_REQUIRED_HOOKS.sessionStart],
        agentStop: [COPILOT_REQUIRED_HOOKS.agentStop],
        sessionEnd: [COPILOT_REQUIRED_HOOKS.sessionEnd],
      },
    };
    await writeJsonFile(paths.hookPath, config);
    return true;
  }

  const config = await readJsonFile<CopilotHooksConfig>(paths.hookPath);
  const updated = registerHooks(config);

  if (updated) {
    await writeJsonFile(paths.hookPath, config);
  }

  return updated;
}

function registerHooks(config: CopilotHooksConfig): boolean {
  let updated = false;

  if (config.version == null) {
    config.version = 1;
    updated = true;
  }

  if (!config.hooks) {
    config.hooks = {};
    updated = true;
  }

  updated =
    ensureHookEntry(config.hooks, 'sessionStart', COPILOT_REQUIRED_HOOKS.sessionStart) ||
    updated;
  updated =
    ensureHookEntry(config.hooks, 'agentStop', COPILOT_REQUIRED_HOOKS.agentStop) ||
    updated;
  updated =
    ensureHookEntry(config.hooks, 'sessionEnd', COPILOT_REQUIRED_HOOKS.sessionEnd) ||
    updated;

  return updated;
}

function ensureHookEntry(
  hooks: NonNullable<CopilotHooksConfig['hooks']>,
  key: 'sessionStart' | 'agentStop' | 'sessionEnd',
  entry: HookCommand,
): boolean {
  const existing = hooks[key];
  if (existing === undefined) {
    hooks[key] = [entry];
    return true;
  }

  if (!Array.isArray(existing)) {
    throw new Error(`Hook list "${key}" must be an array.`);
  }

  if (existing.some((item) => isSameHook(item, entry))) {
    return false;
  }

  existing.push(entry);
  return true;
}

function isSameHook(left: HookCommand, right: HookCommand): boolean {
  return (
    left.type === right.type &&
    left.bash === right.bash &&
    left.powershell === right.powershell &&
    left.timeoutSec === right.timeoutSec
  );
}

// =============================================================================
// Copilot Instructions (.github/copilot-instructions.md)
// =============================================================================

async function ensureCopilotInstructions(paths: CopilotPaths): Promise<boolean> {
  const exists = await fileExists(paths.copilotInstructionsPath);
  if (!exists) {
    const contents = `# Copilot Instructions\n\n${AGENTS_ANCHOR_LINE}\n`;
    await appendFile(paths.copilotInstructionsPath, contents);
    return true;
  }

  if (await fileContainsLine(paths.copilotInstructionsPath, AGENTS_ANCHOR_LINE)) {
    return false;
  }

  await appendFile(
    paths.copilotInstructionsPath,
    `\n\n${AGENTS_ANCHOR_LINE}\n`,
  );
  return true;
}

// =============================================================================
// Standalone Copilot Setup (for combined init)
// =============================================================================

export async function copilotSetup(cwd: string): Promise<CopilotSetupResult> {
  const paths = getCopilotPaths(cwd);
  await mkdir(paths.hooksDir, { recursive: true });

  const hooksUpdated = await ensureHookConfig(paths);
  const instructionsUpdated = await ensureCopilotInstructions(paths);

  return { hooksUpdated, instructionsUpdated };
}

// =============================================================================
// Command Registration
// =============================================================================

export function initCopilotCommand(cli: CAC, context: CommandContext): void {
  cli.command('init-copilot', 'Initialize Copilot MemoryAnchor workspace').action(async () => {
    const cwd = process.cwd();

    const common = await initPublic(cwd);
    const specific = await copilotSetup(cwd);

    if (
      common.gitignoreUpdated ||
      common.anchorFilesCreated ||
      specific.hooksUpdated ||
      common.agentsCreated ||
      specific.instructionsUpdated
    ) {
      context.logger.info('Memory anchor initialized in ./.memoryanchor and ./.github');
    } else {
      context.logger.info('Memory anchor already exists in ./.memoryanchor and ./.github');
    }
  });
}
