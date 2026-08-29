import { createReadStream, existsSync } from 'node:fs';
import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildChartFull, destroyPool } from '../../chartBuild/buildChart.js';
import {
  AGENTS_CONTENT,
  GITIGNORE_ENTRY,
  GUARDRAILS_FILE_NAME,
  INDEX_FILE_NAME,
  LEGACY_BALLAST_FILE_NAME,
  LEGACY_MANIFEST_FILE_NAME,
  PROJECT_STATE_DEFAULT_CONTENT,
  PROJECT_STATE_FILE_NAME,
} from '../../constant.js';
import { ensureGuardrailsFile } from '../../chartBuild/init-guardrails.js';
import { scanAvailableParsers } from '../../chartBuild/scan-parsers.js';
import { ensurePromptHookConfig } from './promptHookConfig.js';

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
    await appendFile(gitignorePath, `${GITIGNORE_ENTRY.join('\n')}\n`);
    return true;
  }

  for (const entry of GITIGNORE_ENTRY) {
    if (!(await fileContainsLine(gitignorePath, entry))) {
      await appendFile(gitignorePath, `\n${entry}\n`);
    }
  }

  return true;
}

/** Move legacy memory files to their clearer canonical names without data loss. */
export async function migrateLegacyAnchorFiles(memoryAnchorDir: string): Promise<boolean> {
  const migrations = [
    [LEGACY_BALLAST_FILE_NAME, GUARDRAILS_FILE_NAME],
    [LEGACY_MANIFEST_FILE_NAME, PROJECT_STATE_FILE_NAME],
  ] as const;
  let migrated = false;

  for (const [legacyName, canonicalName] of migrations) {
    const legacyPath = path.join(memoryAnchorDir, legacyName);
    const canonicalPath = path.join(memoryAnchorDir, canonicalName);
    if (!(await fileExists(legacyPath)) || await fileExists(canonicalPath)) continue;
    await rename(legacyPath, canonicalPath);
    migrated = true;
  }

  return migrated;
}

export async function ensureAnchorFiles(memoryAnchorDir: string): Promise<boolean> {
  const migrated = await migrateLegacyAnchorFiles(memoryAnchorDir);
  const chartCreated = await ensureFile(path.join(memoryAnchorDir, INDEX_FILE_NAME));
  const guardrailsCreated = await ensureGuardrailsFile(
    path.join(memoryAnchorDir, GUARDRAILS_FILE_NAME)
  );
  const projectStateCreated = await ensureFile(
    path.join(memoryAnchorDir, PROJECT_STATE_FILE_NAME),
    PROJECT_STATE_DEFAULT_CONTENT
  );
  const promptHookConfigCreated = await ensurePromptHookConfig(memoryAnchorDir);

  return migrated || chartCreated || guardrailsCreated || projectStateCreated || promptHookConfigCreated;
}

export async function ensureAgentsFile(agentsPath: string): Promise<boolean> {
  const normalizedContent = AGENTS_CONTENT.trim();
  if (!(await fileExists(agentsPath))) {
    await writeFile(agentsPath, `${normalizedContent}\n`, 'utf8');
    return true;
  }

  const current = await readFile(agentsPath, 'utf8');
  const startMarker = '## Memory Anchor Rules';
  const endMarker = '## Memory Anchor Ends';
  const start = current.indexOf(startMarker);

  if (start === -1) {
    return ensureFileWithAppend(agentsPath, AGENTS_CONTENT);
  }

  const endMarkerStart = current.indexOf(endMarker, start);
  if (endMarkerStart === -1) {
    return ensureFileWithAppend(agentsPath, AGENTS_CONTENT);
  }

  const end = endMarkerStart + endMarker.length;
  const existingBlock = current.slice(start, end);
  if (existingBlock === normalizedContent) {
    return false;
  }

  const updated = `${current.slice(0, start)}${normalizedContent}${current.slice(end)}`;
  await writeFile(agentsPath, updated, 'utf8');
  return true;
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
  guardrailsPath: string;
  projectStatePath: string;
  gitignorePath: string;
  agentsPath: string;
}

export function getBasePaths(cwd: string): BasePaths {
  const memoryAnchorDir = path.join(cwd, '.memoryanchor');
  return {
    memoryAnchorDir,
    chartPath: path.join(memoryAnchorDir, INDEX_FILE_NAME),
    guardrailsPath: path.join(memoryAnchorDir, GUARDRAILS_FILE_NAME),
    projectStatePath: path.join(memoryAnchorDir, PROJECT_STATE_FILE_NAME),
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
  // Scan available WASM parsers and write to src/parsers.json (development mode)
  const __initDirname = path.dirname(fileURLToPath(import.meta.url));
  const wasmDir = path.resolve(__initDirname, '..', '..', '..', 'tree-sitter-parser');
  const availableParsers = scanAvailableParsers(wasmDir);
  const srcDir = path.resolve(__initDirname, '..', '..', '..', 'src');
  if (existsSync(srcDir)) {
    await writeFile(
      path.join(srcDir, 'parsers.json'),
      `${JSON.stringify([...availableParsers].sort(), null, 2)}\n`
    );
  }

  const paths = getBasePaths(cwd);

  await ensureWorkspaceDirectories(paths.memoryAnchorDir);

  const gitignoreUpdated = await ensureGitignore(paths.gitignorePath);
  const anchorFilesCreated = await ensureAnchorFiles(paths.memoryAnchorDir);
  const agentsCreated = await ensureAgentsFile(paths.agentsPath);

  await buildChartFull();

  await destroyPool();

  return { gitignoreUpdated, anchorFilesCreated, agentsCreated };
}
