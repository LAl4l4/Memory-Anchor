import { CAC } from 'cac';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { CommandContext } from '../../core/context.js';
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
  command: string;
  timeout: number;
}

interface CodexHooksConfig {
  sessionStart?: CodexHookCommand[];
  sessionEnd?: CodexHookCommand[];
  stop?: CodexHookCommand[];
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

const CODEX_START_HOOK: CodexHookCommand = {
  command: 'memoryanchor-codex-pre',
  timeout: 5,
};

const CODEX_STOP_HOOK: CodexHookCommand = {
  command: 'memoryanchor-codex-stop',
  timeout: 10,
};

const CODEX_END_HOOK: CodexHookCommand = {
  command: 'memoryanchor-codex-post',
  timeout: 10,
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
      sessionStart: [CODEX_START_HOOK],
      stop: [CODEX_STOP_HOOK],
      sessionEnd: [CODEX_END_HOOK],
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

  updated = ensureCodexHookEntry(config, 'sessionStart', CODEX_START_HOOK) || updated;
  updated = ensureCodexHookEntry(config, 'stop', CODEX_STOP_HOOK) || updated;
  updated = ensureCodexHookEntry(config, 'sessionEnd', CODEX_END_HOOK) || updated;

  return updated;
}

function ensureCodexHookEntry(
  config: CodexHooksConfig,
  key: string,
  entry: CodexHookCommand,
): boolean {
  const existing = config[key];
  if (existing === undefined) {
    config[key] = [entry];
    return true;
  }

  if (!Array.isArray(existing)) {
    throw new Error(`Hook list "${key}" must be an array.`);
  }

  // Check if a memoryanchor hook with the same command already exists
  const alreadyExists = existing.some(
    (hookCmd) => hookCmd.command === entry.command,
  );

  if (alreadyExists) {
    return false;
  }

  existing.push(entry);
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
