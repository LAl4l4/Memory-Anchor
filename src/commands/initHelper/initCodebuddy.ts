import { CAC } from 'cac';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import type { CommandContext } from '../../core/context.js';
import {
  type BasePaths,
  getBasePaths,
  initPublic,
  fileExists,
  readJsonFile,
  writeJsonFile,
  fileContainsLine,
} from './initPublic.js';

// =============================================================================
// CodeBuddy-Specific Types
// =============================================================================

interface CodebuddyHookCommand {
  type: 'command';
  command: string;
}

interface CodebuddyHookEntry {
  hooks: CodebuddyHookCommand[];
  matcher?: string;
}

interface CodebuddyHooksConfig {
  hooks?: {
    SessionStart?: CodebuddyHookEntry[];
    Stop?: CodebuddyHookEntry[];
    SessionEnd?: CodebuddyHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface CodebuddyPaths extends BasePaths {
  codebuddyDir: string;
  settingsPath: string;
  codebuddyMdPath: string;
}

export interface CodebuddySetupResult {
  settingsUpdated: boolean;
  codebuddyMdUpdated: boolean;
}

// =============================================================================
// CodeBuddy-Specific Constants
// =============================================================================

const CODEBUDDY_START_HOOK: CodebuddyHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: 'memoryanchor-codebuddy-pre' }],
};

const CODEBUDDY_STOP_HOOK: CodebuddyHookEntry = {
  hooks: [{ type: 'command', command: 'memoryanchor-codebuddy-stop' }],
};

const CODEBUDDY_END_HOOK: CodebuddyHookEntry = {
  hooks: [{ type: 'command', command: 'memoryanchor-codebuddy-post' }],
};

const CODEBUDDY_MD_LINE = '- Follow `AGENTS.md` for Memory Anchor rules.';

// =============================================================================
// CodeBuddy Paths
// =============================================================================

function getCodebuddyPaths(cwd: string): CodebuddyPaths {
  const base = getBasePaths(cwd);
  const codebuddyDir = path.join(cwd, '.codebuddy');

  return {
    ...base,
    codebuddyDir,
    settingsPath: path.join(codebuddyDir, 'settings.json'),
    codebuddyMdPath: path.join(cwd, 'CODEBUDDY.md'),
  };
}

// =============================================================================
// CodeBuddy Hooks (.codebuddy/settings.json)
// =============================================================================

async function ensureCodebuddySettings(paths: CodebuddyPaths): Promise<boolean> {
  await mkdir(paths.codebuddyDir, { recursive: true });

  const exists = await fileExists(paths.settingsPath);
  if (!exists) {
    const config: CodebuddyHooksConfig = {
      hooks: {
        SessionStart: [CODEBUDDY_START_HOOK],
        Stop: [CODEBUDDY_STOP_HOOK],
        SessionEnd: [CODEBUDDY_END_HOOK],
      },
    };
    await writeJsonFile(paths.settingsPath, config);
    return true;
  }

  const config = await readJsonFile<CodebuddyHooksConfig>(paths.settingsPath);
  const updated = registerCodebuddyHooks(config);

  if (updated) {
    await writeJsonFile(paths.settingsPath, config);
  }

  return updated;
}

function registerCodebuddyHooks(config: CodebuddyHooksConfig): boolean {
  let updated = false;

  if (!config.hooks) {
    config.hooks = {};
    updated = true;
  }

  updated = ensureCodebuddyHookEntry(config.hooks, 'SessionStart', CODEBUDDY_START_HOOK) || updated;
  updated = ensureCodebuddyHookEntry(config.hooks, 'Stop', CODEBUDDY_STOP_HOOK) || updated;
  updated = ensureCodebuddyHookEntry(config.hooks, 'SessionEnd', CODEBUDDY_END_HOOK) || updated;

  return updated;
}

function ensureCodebuddyHookEntry(
  hooks: NonNullable<CodebuddyHooksConfig['hooks']>,
  key: string,
  entry: CodebuddyHookEntry,
): boolean {
  const existing = hooks[key];
  if (existing === undefined) {
    hooks[key] = [entry];
    return true;
  }

  if (!Array.isArray(existing)) {
    throw new Error(`Hook list "${key}" must be an array.`);
  }

  const cmd = entry.hooks[0].command;
  const alreadyExists = existing.some(
    (hookEntry) =>
      hookEntry.hooks?.some((h: CodebuddyHookCommand) => h.command === cmd),
  );

  if (alreadyExists) {
    return false;
  }

  existing.push(entry);
  return true;
}

// =============================================================================
// CODEBUDDY.md Update
// =============================================================================

async function ensureCodebuddyMd(paths: CodebuddyPaths): Promise<boolean> {
  const exists = await fileExists(paths.codebuddyMdPath);
  if (!exists) {
    const content = `# Memory Anchor\n\n${CODEBUDDY_MD_LINE}\n`;
    await appendFile(paths.codebuddyMdPath, content);
    return true;
  }

  if (await fileContainsLine(paths.codebuddyMdPath, CODEBUDDY_MD_LINE)) {
    return false;
  }

  await appendFile(paths.codebuddyMdPath, `\n\n${CODEBUDDY_MD_LINE}\n`);
  return true;
}

// =============================================================================
// Standalone CodeBuddy Setup (for combined init)
// =============================================================================

export async function codebuddySetup(cwd: string): Promise<CodebuddySetupResult> {
  const paths = getCodebuddyPaths(cwd);

  const settingsUpdated = await ensureCodebuddySettings(paths);
  const codebuddyMdUpdated = await ensureCodebuddyMd(paths);

  return { settingsUpdated, codebuddyMdUpdated };
}

// =============================================================================
// Command Registration
// =============================================================================

export function initCodebuddyCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('init-codebuddy', 'Initialize CodeBuddy MemoryAnchor workspace')
    .action(async () => {
      const cwd = process.cwd();

      const common = await initPublic(cwd);
      const specific = await codebuddySetup(cwd);

      if (
        common.gitignoreUpdated ||
        common.anchorFilesCreated ||
        specific.settingsUpdated ||
        common.agentsCreated ||
        specific.codebuddyMdUpdated
      ) {
        context.logger.info(
          'Memory anchor initialized for CodeBuddy in ./.memoryanchor and ./.codebuddy',
        );
      } else {
        context.logger.info(
          'Memory anchor for CodeBuddy already exists in ./.memoryanchor and ./.codebuddy',
        );
      }
    });
}
