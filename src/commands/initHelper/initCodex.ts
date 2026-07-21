import { CAC } from 'cac';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { CommandContext } from '../../types.js';
import { HOOK_COMMANDS } from '../../constant.js';
import {
  type BasePaths,
  getBasePaths,
  initPublic,
  fileExists,
  readJsonFile,
  writeJsonFile,
} from './initPublic.js';

// =============================================================================
// Codex-Specific Types
// =============================================================================

interface CodexHookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

interface CodexHookEntry {
  matcher: string;
  hooks: CodexHookCommand[];
}

interface CodexHooksConfig {
  hooks?: {
    SessionStart?: CodexHookEntry[];
    SessionEnd?: CodexHookEntry[];
    Stop?: CodexHookEntry[];
  };
  [key: string]: unknown;
}

interface CodexPaths extends BasePaths {
  codexDir: string;
  hooksConfigPath: string;
}

export interface CodexSetupResult {
  hooksUpdated: boolean;
}

// =============================================================================
// Codex-Specific Constants
// =============================================================================

const CODEX_START_HOOK: CodexHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: HOOK_COMMANDS.CODEX_PRE, timeout: 10 }],
};

const CODEX_STOP_HOOK: CodexHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: HOOK_COMMANDS.CODEX_STOP, timeout: 10 }],
};

// =============================================================================
// Codex Paths
// =============================================================================

function getCodexPaths(cwd: string): CodexPaths {
  const base = getBasePaths(cwd);
  const codexDir = path.join(cwd, '.codex');

  return {
    ...base,
    codexDir,
    hooksConfigPath: path.join(codexDir, 'hooks.json'),
  };
}

// =============================================================================
// Codex Hooks (.codex/hooks.json)
// =============================================================================

async function ensureCodexHooks(paths: CodexPaths): Promise<boolean> {
  // Ensure .codex/ directory exists
  await mkdir(paths.codexDir, { recursive: true });

  const exists = await fileExists(paths.hooksConfigPath);
  if (!exists) {
    const config: CodexHooksConfig = {
      hooks: {
        SessionStart: [CODEX_START_HOOK],
        Stop: [CODEX_STOP_HOOK],
      }
    };
    await writeJsonFile(paths.hooksConfigPath, config);
    return true;
  }

  const config = await readJsonFile<CodexHooksConfig>(paths.hooksConfigPath);
  const updated = registerCodexHooks(config);

  if (updated) {
    await writeJsonFile(paths.hooksConfigPath, config);
  }

  return updated;
}

function registerCodexHooks(config: CodexHooksConfig): boolean {
  let updated = false;

  updated = ensureCodexHookEntry(config, 'SessionStart', CODEX_START_HOOK) || updated;
  updated = ensureCodexHookEntry(config, 'Stop', CODEX_STOP_HOOK) || updated;
  updated = removeLegacyCodexSessionEndHook(config) || updated;

  return updated;
}

function ensureCodexHookEntry(
  config: CodexHooksConfig,
  key: 'SessionStart' | 'Stop',
  entry: CodexHookEntry,
): boolean {
  if (config.hooks === undefined) {
    config.hooks = {};
  }

  if (config.hooks[key] === undefined) {
    config.hooks[key] = [entry];
    return true;
  }

  if (!Array.isArray(config.hooks[key])) {
    throw new Error(`Hook list "${key}" must be an array.`);
  }

  // Check if a memoryanchor hook with the same command already exists
  const alreadyExists = config.hooks[key]?.some(
    (hookEntry) =>
      hookEntry.hooks?.some((cmd: CodexHookCommand) => cmd.command === entry.hooks[0].command),
  );

  if (alreadyExists) {
    return false;
  }

  config.hooks[key].push(entry);
  return true;
}

/**
 * Codex has no SessionEnd event. Remove only Memory Anchor's obsolete entry
 * from existing configs, preserving any unrelated user configuration.
 */
function removeLegacyCodexSessionEndHook(config: CodexHooksConfig): boolean {
  const sessionEnd = config.hooks?.SessionEnd;
  if (sessionEnd === undefined) {
    return false;
  }

  if (!Array.isArray(sessionEnd)) {
    throw new Error('Hook list "SessionEnd" must be an array.');
  }

  let removed = false;
  const remaining = sessionEnd
    .map((entry) => {
      const hooks = entry.hooks.filter((command) => {
        const isLegacyMemoryAnchorHook = command.command === 'memoryanchor-codex-post';
        removed = removed || isLegacyMemoryAnchorHook;
        return !isLegacyMemoryAnchorHook;
      });
      return { ...entry, hooks };
    })
    .filter((entry) => entry.hooks.length > 0);

  if (!removed) {
    return false;
  }

  if (remaining.length === 0) {
    delete config.hooks!.SessionEnd;
  } else {
    config.hooks!.SessionEnd = remaining;
  }
  return true;
}

// =============================================================================
// Standalone Codex Setup (for combined init)
// =============================================================================

export async function codexSetup(cwd: string): Promise<CodexSetupResult> {
  const paths = getCodexPaths(cwd);

  const hooksUpdated = await ensureCodexHooks(paths);

  return { hooksUpdated };
}

// =============================================================================
// Command Registration
// =============================================================================

export function initCodexCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('init-codex', 'Initialize Codex CLI MemoryAnchor workspace')
    .action(async () => {
      const cwd = process.cwd();

      const common = await initPublic(cwd);
      const specific = await codexSetup(cwd);

      if (
        common.gitignoreUpdated ||
        common.anchorFilesCreated ||
        specific.hooksUpdated ||
        common.agentsCreated
      ) {
        context.logger.info(
          'Memory anchor initialized for Codex CLI in ./.memoryanchor and ./.codex',
        );
      } else {
        context.logger.info(
          'Memory anchor for Codex CLI already exists in ./.memoryanchor and ./.codex',
        );
      }
    });
}
