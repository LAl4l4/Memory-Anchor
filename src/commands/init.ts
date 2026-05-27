import type { CAC } from 'cac';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandContext } from '../core/context';
import { buildChartFull } from '../core/build-chart';

interface HookCommand {
  type: 'command';
  bash: string;
  powershell: string;
  timeoutSec: number;
}

interface HooksConfig {
  version?: number;
  hooks?: {
    sessionStart?: HookCommand[];
    sessionEnd?: HookCommand[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface WorkspacePaths {
  memoryAnchorDir: string;
  chartPath: string;
  ballastPath: string;
  manifestPath: string;
  hooksDir: string;
  hookPath: string;
  agentsPath: string;
  copilotInstructionsPath: string;
}

const REQUIRED_HOOKS: Record<'sessionStart' | 'sessionEnd', HookCommand> = {
  sessionStart: {
    type: 'command',
    bash: 'node .memoryanchor/dist/pre-session.js',
    powershell: 'node .memoryanchor/dist/pre-session.js',
    timeoutSec: 10
  },
  sessionEnd: {
    type: 'command',
    bash: 'node .memoryanchor/dist/post-session.js',
    powershell: 'node .memoryanchor/dist/post-session.js',
    timeoutSec: 10
  }
};

const AGENTS_CONTENT = `# AGENTS

## Memory Anchor Rules
- Required memory files:
  - ./.memoryanchor/chart.md
  - ./.memoryanchor/ballast.md
  - ./.memoryanchor/manifest.md
- Always read chart.md first.
- Only open repository files when the chart is insufficient.
- Must follow all rules in ballast.md.
- At the end of a session, update TODO/DONE entries in manifest.md.

For '.memoryanchor/ballast.md':
Keep only valid rules. Delete obsolete ones.
Use one line per rule with exact format:
'- [ ] Rule content'
## Memory Anchor Ends
`;

const COPILOT_INSTRUCTIONS_LINE =
  '- Follow `AGENTS.md` for Memory Anchor rules.';

export function initCommand(cli: CAC, context: CommandContext): void {
  cli.command('init', 'Initialize CopilotWolf workspace').action(async () => {
    const paths = getWorkspacePaths(process.cwd());

    await ensureWorkspaceDirectories(paths);

    const anchorFilesCreated = await ensureAnchorFiles(paths);
    const hooksUpdated = await ensureHookConfig(paths);
    const agentsCreated = await ensureAgentsFile(paths);
    const instructionsUpdated = await ensureCopilotInstructions(paths);
    buildChartFull();

    if (
      anchorFilesCreated ||
      hooksUpdated ||
      agentsCreated ||
      instructionsUpdated
    ) {
      context.logger.info(
        'Memory anchor initialized in ./.memoryanchor and ./.github'
      );
    } else {
      context.logger.info(
        'Memory anchor already exists in ./.memoryanchor and ./.github'
      );
    }
  });
}

function getWorkspacePaths(cwd: string): WorkspacePaths {
  const memoryAnchorDir = path.join(cwd, '.memoryanchor');
  const hooksDir = path.join(cwd, '.github', 'hooks');

  return {
    memoryAnchorDir,
    chartPath: path.join(memoryAnchorDir, 'chart.md'),
    ballastPath: path.join(memoryAnchorDir, 'ballast.md'),
    manifestPath: path.join(memoryAnchorDir, 'manifest.md'),
    hooksDir,
    hookPath: path.join(hooksDir, 'memory-anchor.json'),
    agentsPath: path.join(cwd, 'AGENTS.md'),
    copilotInstructionsPath: path.join(cwd, '.github', 'copilot-instructions.md')
  };
}

async function ensureWorkspaceDirectories(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.memoryAnchorDir, { recursive: true });
  await mkdir(paths.hooksDir, { recursive: true });
}

async function ensureAnchorFiles(paths: WorkspacePaths): Promise<boolean> {
  const chartCreated = await ensureFile(paths.chartPath);
  const ballastCreated = await ensureFile(paths.ballastPath);
  const manifestCreated = await ensureFile(paths.manifestPath);

  return chartCreated || ballastCreated || manifestCreated;
}

async function ensureAgentsFile(paths: WorkspacePaths): Promise<boolean> {
  return ensureFile(paths.agentsPath, AGENTS_CONTENT);
}

async function ensureCopilotInstructions(
  paths: WorkspacePaths
): Promise<boolean> {
  const exists = await fileExists(paths.copilotInstructionsPath);
  if (!exists) {
    const contents = `# Copilot Instructions\n\n${COPILOT_INSTRUCTIONS_LINE}\n`;
    await writeFile(paths.copilotInstructionsPath, contents);
    return true;
  }

  const existing = await readFile(paths.copilotInstructionsPath, 'utf8');
  if (existing.includes('AGENTS.md')) {
    return false;
  }

  const suffix = existing.endsWith('\n') ? '' : '\n';
  const updated = `${existing}${suffix}\n${COPILOT_INSTRUCTIONS_LINE}\n`;
  await writeFile(paths.copilotInstructionsPath, updated);
  return true;
}

async function ensureHookConfig(paths: WorkspacePaths): Promise<boolean> {
  const exists = await fileExists(paths.hookPath);
  if (!exists) {
    const config: HooksConfig = {
      version: 1,
      hooks: {
        sessionStart: [REQUIRED_HOOKS.sessionStart],
        sessionEnd: [REQUIRED_HOOKS.sessionEnd]
      }
    };
    await writeJsonFile(paths.hookPath, config);
    return true;
  }

  const config = await readJsonFile<HooksConfig>(paths.hookPath);
  const updated = registerHooks(config);

  if (updated) {
    await writeJsonFile(paths.hookPath, config);
  }

  return updated;
}

function registerHooks(config: HooksConfig): boolean {
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
    ensureHookEntry(config.hooks, 'sessionStart', REQUIRED_HOOKS.sessionStart) ||
    updated;
  updated =
    ensureHookEntry(config.hooks, 'sessionEnd', REQUIRED_HOOKS.sessionEnd) ||
    updated;

  return updated;
}

function ensureHookEntry(
  hooks: HooksConfig['hooks'],
  key: 'sessionStart' | 'sessionEnd',
  entry: HookCommand
): boolean {
  if (!hooks) {
    throw new Error('Hook configuration is missing the hooks object.');
  }

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT') {
        return false;
      }
    }
    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, 'utf8');
  return JSON.parse(contents) as T;
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(filePath, contents);
}

async function ensureFile(filePath: string, content = ''): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT') {
        await writeFile(filePath, content);
        return true;
      }
    }
    throw error;
  }
}
