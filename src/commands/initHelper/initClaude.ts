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
// Claude-Specific Types
// =============================================================================

interface ClaudeHookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

interface ClaudeHookEntry {
  matcher: string;
  hooks: ClaudeHookCommand[];
}

interface ClaudeHooksConfig {
  hooks?: {
    SessionStart?: ClaudeHookEntry[];
    Stop?: ClaudeHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ClaudePaths extends BasePaths {
  claudeSettingsPath: string;
  claudeMdPath: string;
}

export interface ClaudeSetupResult {
  settingsUpdated: boolean;
  claudeMdUpdated: boolean;
}

// =============================================================================
// Claude-Specific Constants
// =============================================================================

// pre-session
const CLAUDE_START_HOOK: ClaudeHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: 'memoryanchor-claude-pre', timeout: 5 }],
};

const CLAUDE_STOP_HOOK: ClaudeHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: 'memoryanchor-claude-stop', timeout: 10 }],
};

// post-session
const CLAUDE_END_HOOK: ClaudeHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: 'memoryanchor-claude-post', timeout: 10 }],
};

const CLAUDE_MD_LINE = '- Follow `AGENTS.md` for Memory Anchor rules.';

// =============================================================================
// Claude Paths
// =============================================================================

function getClaudePaths(cwd: string): ClaudePaths {
  const base = getBasePaths(cwd);

  return {
    ...base,
    claudeSettingsPath: path.join(cwd, '.claude', 'settings.json'),
    claudeMdPath: path.join(cwd, 'CLAUDE.md'),
  };
}

// =============================================================================
// Claude Hooks (.claude/settings.json)
// =============================================================================

async function ensureClaudeSettings(paths: ClaudePaths): Promise<boolean> {
  // Ensure .claude/ directory exists
  await mkdir(path.dirname(paths.claudeSettingsPath), { recursive: true });

  const exists = await fileExists(paths.claudeSettingsPath);
  if (!exists) {
    const config: ClaudeHooksConfig = {
      hooks: {
        SessionStart: [CLAUDE_START_HOOK],
        Stop: [CLAUDE_STOP_HOOK],
      },
    };
    await writeJsonFile(paths.claudeSettingsPath, config);
    return true;
  }

  const config = await readJsonFile<ClaudeHooksConfig>(paths.claudeSettingsPath);
  const updated = registerClaudeHooks(config);

  if (updated) {
    await writeJsonFile(paths.claudeSettingsPath, config);
  }

  return updated;
}

function registerClaudeHooks(config: ClaudeHooksConfig): boolean {
  let updated = false;

  if (!config.hooks) {
    config.hooks = {};
    updated = true;
  }

    updated = ensureClaudeHookEntry(config.hooks, 'SessionStart', CLAUDE_START_HOOK) || updated;
    updated = ensureClaudeHookEntry(config.hooks, 'Stop', CLAUDE_STOP_HOOK) || updated;
    updated = ensureClaudeHookEntry(config.hooks, 'SessionEnd', CLAUDE_END_HOOK) || updated;

  return updated;
}

function ensureClaudeHookEntry(
  hooks: NonNullable<ClaudeHooksConfig['hooks']>,
  key: string,
  entry: ClaudeHookEntry,
): boolean {
  const existing = hooks[key];
  if (existing === undefined) {
    hooks[key] = [entry];
    return true;
  }

  if (!Array.isArray(existing)) {
    throw new Error(`Hook list "${key}" must be an array.`);
  }

  // Check if a memoryanchor hook with the same command already exists
  const memoryanchorCmd = entry.hooks[0].command;
  const alreadyExists = existing.some(
    (hookEntry) =>
      hookEntry.hooks?.some((cmd: ClaudeHookCommand) => cmd.command === memoryanchorCmd),
  );

  if (alreadyExists) {
    return false;
  }

  existing.push(entry);
  return true;
}

// =============================================================================
// CLAUDE.md Update
// =============================================================================

async function ensureClaudeMd(paths: ClaudePaths): Promise<boolean> {
  const exists = await fileExists(paths.claudeMdPath);
  if (!exists) {
    const content = `# Memory Anchor\n\n${CLAUDE_MD_LINE}\n`;
    await appendFile(paths.claudeMdPath, content);
    return true;
  }

  if (await fileContainsLine(paths.claudeMdPath, CLAUDE_MD_LINE)) {
    return false;
  }

  await appendFile(paths.claudeMdPath, `\n\n${CLAUDE_MD_LINE}\n`);
  return true;
}

// =============================================================================
// Standalone Claude Setup (for combined init)
// =============================================================================

export async function claudeSetup(cwd: string): Promise<ClaudeSetupResult> {
  const paths = getClaudePaths(cwd);

  const settingsUpdated = await ensureClaudeSettings(paths);
  const claudeMdUpdated = await ensureClaudeMd(paths);

  return { settingsUpdated, claudeMdUpdated };
}

// =============================================================================
// Command Registration
// =============================================================================

export function initClaudeCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('init-claude', 'Initialize Claude MemoryAnchor workspace')
    .action(async () => {
      const cwd = process.cwd();

      const common = await initPublic(cwd);
      const specific = await claudeSetup(cwd);

      if (
        common.gitignoreUpdated ||
        common.anchorFilesCreated ||
        specific.settingsUpdated ||
        common.agentsCreated ||
        specific.claudeMdUpdated
      ) {
        context.logger.info(
          'Memory anchor initialized for Claude in ./.memoryanchor and ./.claude',
        );
      } else {
        context.logger.info(
          'Memory anchor for Claude already exists in ./.memoryanchor and ./.claude',
        );
      }
    });
}
