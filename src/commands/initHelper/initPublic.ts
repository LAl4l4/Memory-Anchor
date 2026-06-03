import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { buildChartFull } from '../../core/build-chart.js';

// =============================================================================
// Constants
// =============================================================================

export const AGENTS_CONTENT = `
## Memory Anchor Rules
- Required memory files:
  - ./.memoryanchor/chart.md
  - ./.memoryanchor/ballast.md
  - ./.memoryanchor/manifest.md
- Always read chart.md before accessing any repository files.
- Only open repository files when the chart is insufficient.
- Must follow all rules in ballast.md.
- After each turn, update TODO/DONE entries in manifest.md.

For '.memoryanchor/ballast.md':
Keep only valid rules. Delete obsolete ones.
Use one line per rule with exact format:
'- [ ] Rule content'
## Memory Anchor Ends
`;

export const GITIGNORE_ENTRY = '.memoryanchor';
export const BALLAST_DEFAULT_RULE = '- [ ] Follow AGENTS.md rules.\n- [ ] Do not repeat yourself.';
export const BALLAST_DEFAULT_CONTENT = `${BALLAST_DEFAULT_RULE}\n`;
export const MANIFEST_DEFAULT_CONTENT = '## Todo:\n\n## Done:\n';

// =============================================================================
// Types
// =============================================================================

export interface HookCommand {
  type: 'command';
  bash: string;
  powershell: string;
  timeoutSec: number;
}

// =============================================================================
// Utility Functions
// =============================================================================

export async function fileExists(filePath: string): Promise<boolean> {
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

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, 'utf8');
  return JSON.parse(contents) as T;
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(filePath, contents);
}

export async function ensureFile(filePath: string, content = ''): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT') {
        await appendFile(filePath, content);
        return true;
      }
    }
    throw error;
  }
}

export async function ensureFileWithAppend(
  filePath: string,
  content: string
): Promise<boolean> {
  const normalizedContent = content.trimEnd();
  const exists = await fileExists(filePath);
  if (!exists) {
    await appendFile(filePath, `${normalizedContent}\n`);
    return true;
  }

  if (await fileContains(filePath, normalizedContent)) {
    return false;
  }

  await appendFile(filePath, `\n\n${normalizedContent}\n`);
  return true;
}

export async function fileContainsLine(
  filePath: string,
  lineValue: string
): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.trim() === lineValue) {
        rl.close();
        stream.destroy();
        return true;
      }
    }
  } finally {
    rl.close();
  }

  return false;
}

export async function fileContains(
  filePath: string,
  needle: string
): Promise<boolean> {
  if (needle.length === 0) {
    return true;
  }

  return await new Promise<boolean>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    let buffer = '';
    let found = false;

    stream.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes(needle)) {
        found = true;
        stream.destroy();
        return;
      }

      const keepLength = Math.max(needle.length - 1, 0);
      if (buffer.length > keepLength) {
        buffer = keepLength > 0 ? buffer.slice(-keepLength) : '';
      }
    });

    stream.on('error', (error) => reject(error));
    stream.on('close', () => resolve(found));
  });
}

export async function ensureGitignore(gitignorePath: string): Promise<boolean> {
  const exists = await fileExists(gitignorePath);
  if (!exists) {
    await appendFile(gitignorePath, `${GITIGNORE_ENTRY}\n`);
    return true;
  }

  if (await fileContainsLine(gitignorePath, GITIGNORE_ENTRY)) {
    return false;
  }

  await appendFile(gitignorePath, `\n${GITIGNORE_ENTRY}\n`);
  return true;
}

export async function ensureAnchorFiles(memoryAnchorDir: string): Promise<boolean> {
  const chartCreated = await ensureFile(path.join(memoryAnchorDir, 'chart.md'));
  const ballastCreated = await ensureFile(
    path.join(memoryAnchorDir, 'ballast.md'),
    BALLAST_DEFAULT_CONTENT
  );
  const manifestCreated = await ensureFile(
    path.join(memoryAnchorDir, 'manifest.md'),
    MANIFEST_DEFAULT_CONTENT
  );

  return chartCreated || ballastCreated || manifestCreated;
}

export async function ensureAgentsFile(agentsPath: string): Promise<boolean> {
  return ensureFileWithAppend(agentsPath, AGENTS_CONTENT);
}

export async function ensureWorkspaceDirectories(memoryAnchorDir: string): Promise<void> {
  await mkdir(memoryAnchorDir, { recursive: true });
}

// =============================================================================
// Base Paths (shared between Copilot and Claude variants)
// =============================================================================

export interface BasePaths {
  memoryAnchorDir: string;
  chartPath: string;
  ballastPath: string;
  manifestPath: string;
  gitignorePath: string;
  agentsPath: string;
}

export function getBasePaths(cwd: string): BasePaths {
  const memoryAnchorDir = path.join(cwd, '.memoryanchor');
  return {
    memoryAnchorDir,
    chartPath: path.join(memoryAnchorDir, 'chart.md'),
    ballastPath: path.join(memoryAnchorDir, 'ballast.md'),
    manifestPath: path.join(memoryAnchorDir, 'manifest.md'),
    gitignorePath: path.join(cwd, '.gitignore'),
    agentsPath: path.join(cwd, 'AGENTS.md'),
  };
}

// =============================================================================
// Public Init (common to all agents)
// =============================================================================

export interface InitPublicResult {
  gitignoreUpdated: boolean;
  anchorFilesCreated: boolean;
  agentsCreated: boolean;
}

/** Run the common initialization steps shared by all agents. */
export async function initPublic(cwd: string): Promise<InitPublicResult> {
  const paths = getBasePaths(cwd);

  await ensureWorkspaceDirectories(paths.memoryAnchorDir);

  const gitignoreUpdated = await ensureGitignore(paths.gitignorePath);
  const anchorFilesCreated = await ensureAnchorFiles(paths.memoryAnchorDir);
  const agentsCreated = await ensureAgentsFile(paths.agentsPath);

  await buildChartFull();

  return { gitignoreUpdated, anchorFilesCreated, agentsCreated };
}
