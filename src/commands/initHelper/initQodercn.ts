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
// QoderCN-Specific Types
// =============================================================================

interface QodercnHookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

interface QodercnHookEntry {
  matcher: string;
  hooks: QodercnHookCommand[];
}

interface QodercnHooksConfig {
  hooks?: {
    SessionStart?: QodercnHookEntry[];
    Stop?: QodercnHookEntry[];
    SessionEnd?: QodercnHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QodercnPaths extends BasePaths {
  qoderDir: string;
  settingsPath: string;
}

export interface QodercnSetupResult {
  settingsUpdated: boolean;
}

// =============================================================================
// QoderCN-Specific Constants
// =============================================================================

const QODERCN_START_HOOK: QodercnHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: HOOK_COMMANDS.QODERCN_PRE, timeout: 5 }],
};

const QODERCN_STOP_HOOK: QodercnHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: HOOK_COMMANDS.QODERCN_STOP, timeout: 10 }],
};

const QODERCN_END_HOOK: QodercnHookEntry = {
  matcher: '',
  hooks: [{ type: 'command', command: HOOK_COMMANDS.QODERCN_POST, timeout: 10 }],
};

// =============================================================================
// QoderCN Paths
// =============================================================================

function getQodercnPaths(cwd: string): QodercnPaths {
  const base = getBasePaths(cwd);
  const qoderDir = path.join(cwd, '.qoder');

  return {
    ...base,
    qoderDir,
    settingsPath: path.join(qoderDir, 'settings.json'),
  };
}

// =============================================================================
// QoderCN Hooks (.qoder/settings.json)
// =============================================================================

async function ensureQodercnSettings(paths: QodercnPaths): Promise<boolean> {
  await mkdir(paths.qoderDir, { recursive: true });

  const exists = await fileExists(paths.settingsPath);
  if (!exists) {
    const config: QodercnHooksConfig = {
      hooks: {
        SessionStart: [QODERCN_START_HOOK],
        Stop: [QODERCN_STOP_HOOK],
        SessionEnd: [QODERCN_END_HOOK],
      },
    };
    await writeJsonFile(paths.settingsPath, config);
    return true;
  }

  const config = await readJsonFile<QodercnHooksConfig>(paths.settingsPath);
  const updated = registerQodercnHooks(config);

  if (updated) {
    await writeJsonFile(paths.settingsPath, config);
  }

  return updated;
}

function registerQodercnHooks(config: QodercnHooksConfig): boolean {
  let updated = false;

  if (!config.hooks) {
    config.hooks = {};
    updated = true;
  }

  updated = ensureQodercnHookEntry(config.hooks, 'SessionStart', QODERCN_START_HOOK) || updated;
  updated = ensureQodercnHookEntry(config.hooks, 'Stop', QODERCN_STOP_HOOK) || updated;
  updated = ensureQodercnHookEntry(config.hooks, 'SessionEnd', QODERCN_END_HOOK) || updated;

  return updated;
}

function ensureQodercnHookEntry(
  hooks: NonNullable<QodercnHooksConfig['hooks']>,
  key: string,
  entry: QodercnHookEntry,
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
      hookEntry.hooks?.some((h: QodercnHookCommand) => h.command === cmd),
  );

  if (alreadyExists) {
    return false;
  }

  existing.push(entry);
  return true;
}

// =============================================================================
// Standalone QoderCN Setup (for combined init)
// =============================================================================

export async function qodercnSetup(cwd: string): Promise<QodercnSetupResult> {
  const paths = getQodercnPaths(cwd);

  const settingsUpdated = await ensureQodercnSettings(paths);

  return { settingsUpdated };
}

// =============================================================================
// Command Registration
// =============================================================================

export function initQodercnCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('init-qodercn', 'Initialize QoderCLI CN MemoryAnchor workspace')
    .action(async () => {
      const cwd = process.cwd();

      const common = await initPublic(cwd);
      const specific = await qodercnSetup(cwd);

      if (
        common.gitignoreUpdated ||
        common.anchorFilesCreated ||
        specific.settingsUpdated ||
        common.agentsCreated
      ) {
        context.logger.info(
          'Memory anchor initialized for QoderCLI CN in ./.memoryanchor and ./.qoder',
        );
      } else {
        context.logger.info(
          'Memory anchor for QoderCLI CN already exists in ./.memoryanchor and ./.qoder',
        );
      }
    });
}
