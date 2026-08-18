import { CAC } from 'cac';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { type Document, Scalar, YAMLMap, YAMLSeq, parseDocument } from 'yaml';
import type { CommandContext } from '../../types.js';
import { HOOK_COMMANDS } from '../../constant.js';
import {
  type BasePaths,
  getBasePaths,
  initPublic,
  fileExists,
} from './initPublic.js';
import { isPromptHookEnabled } from './promptHookConfig.js';

// =============================================================================
// Hermes-Specific Types
// =============================================================================

interface HermesHookEntry {
  command: string;
  timeout?: number;
}

interface HermesPaths extends BasePaths {
  hermesHome: string;
  configPath: string;
}

export interface HermesSetupResult {
  configUpdated: boolean;
}

// =============================================================================
// Hermes-Specific Constants
// =============================================================================

const HERMES_PRE_HOOK: HermesHookEntry = {
  command: HOOK_COMMANDS.HERMES_PRE,
  timeout: 5,
};

const HERMES_PROMPT_HOOK: HermesHookEntry = {
  command: HOOK_COMMANDS.HERMES_PROMPT,
  timeout: 5,
};

const HERMES_STOP_HOOK: HermesHookEntry = {
  command: HOOK_COMMANDS.HERMES_STOP,
  timeout: 10,
};

const HERMES_POST_HOOK: HermesHookEntry = {
  command: HOOK_COMMANDS.HERMES_POST,
  timeout: 10,
};

const MANAGED_HERMES_COMMANDS = new Set<string>([
  HOOK_COMMANDS.HERMES_PRE,
  HOOK_COMMANDS.HERMES_PROMPT,
  HOOK_COMMANDS.HERMES_STOP,
  HOOK_COMMANDS.HERMES_POST,
]);

// =============================================================================
// Hermes Paths ($HERMES_HOME/config.yaml, default ~/.hermes/config.yaml)
// =============================================================================

function getHermesHome(): string {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}

function getHermesPaths(cwd: string): HermesPaths {
  const base = getBasePaths(cwd);
  const hermesHome = getHermesHome();

  return {
    ...base,
    hermesHome,
    configPath: path.join(hermesHome, 'config.yaml'),
  };
}

// =============================================================================
// YAML Editing Helpers (round-trip safe: preserves comments and formatting)
// =============================================================================

function getOrCreateMap(parent: YAMLMap, key: string): YAMLMap {
  const existing = parent.get(key, true);
  if (existing instanceof YAMLMap) {
    return existing;
  }

  const created = new YAMLMap();
  parent.set(key, created);
  return created;
}

function getOrCreateSeq(parent: YAMLMap, key: string): YAMLSeq {
  const existing = parent.get(key, true);
  if (existing instanceof YAMLSeq) {
    return existing;
  }

  const created = new YAMLSeq();
  parent.set(key, created);
  return created;
}

function getEntryCommand(entry: unknown): string {
  if (!(entry instanceof YAMLMap)) {
    return '';
  }

  const command = entry.get('command', true);
  return command instanceof Scalar ? String(command.value ?? '') : '';
}

function ensureHookEntry(list: YAMLSeq, entry: HermesHookEntry): boolean {
  for (const item of list.items) {
    if (getEntryCommand(item) === entry.command) {
      return false;
    }
  }

  const node = new YAMLMap();
  node.set('command', entry.command);
  if (entry.timeout !== undefined) {
    node.set('timeout', entry.timeout);
  }
  list.add(node);
  return true;
}

function removeHookEntry(list: YAMLSeq, command: string): boolean {
  const before = list.items.length;
  list.items = list.items.filter((item) => getEntryCommand(item) !== command);
  return list.items.length !== before;
}

// =============================================================================
// Hermes Hooks ($HERMES_HOME/config.yaml `hooks:` block)
// =============================================================================

function registerHermesHooks(doc: Document, promptHookEnabled: boolean): boolean {
  let updated = false;

  const existingHooks = doc.get('hooks', true);
  let hooks: YAMLMap;
  if (existingHooks instanceof YAMLMap) {
    hooks = existingHooks;
  } else {
    hooks = new YAMLMap();
    doc.set('hooks', hooks);
    updated = true;
  }

  const preLlmCall = getOrCreateSeq(hooks, 'pre_llm_call');
  updated = ensureHookEntry(preLlmCall, HERMES_PRE_HOOK) || updated;
  updated = promptHookEnabled
    ? ensureHookEntry(preLlmCall, HERMES_PROMPT_HOOK) || updated
    : removeHookEntry(preLlmCall, HOOK_COMMANDS.HERMES_PROMPT) || updated;

  const sessionEnd = getOrCreateSeq(hooks, 'on_session_end');
  updated = ensureHookEntry(sessionEnd, HERMES_STOP_HOOK) || updated;

  const sessionFinalize = getOrCreateSeq(hooks, 'on_session_finalize');
  updated = ensureHookEntry(sessionFinalize, HERMES_POST_HOOK) || updated;

  return updated;
}

async function ensureHermesConfig(
  paths: HermesPaths,
  promptHookEnabled: boolean,
): Promise<boolean> {
  await mkdir(paths.hermesHome, { recursive: true });

  let doc: Document;
  if (await fileExists(paths.configPath)) {
    doc = parseDocument(await readFile(paths.configPath, 'utf8'));
    if (doc.errors.length > 0) {
      throw new Error(
        `Cannot edit invalid Hermes config ${paths.configPath}: ${doc.errors[0].message}`,
      );
    }
  } else {
    doc = parseDocument('');
    doc.commentBefore =
      ' Memory Anchor managed entries.\n Memory Anchor hooks run on Hermes events and are managed by `anchor init-hermes` and `anchor prompt-hook`.';
  }

  const updated = registerHermesHooks(doc, promptHookEnabled);
  if (updated) {
    const rendered = doc.toString();
    await writeFile(paths.configPath, rendered.endsWith('\n') ? rendered : `${rendered}\n`);
  }

  return updated;
}

/**
 * True when the user's Hermes config already carries at least one managed
 * Memory Anchor hook command. Used by `anchor prompt-hook` to decide
 * whether the global config needs reconciliation like project-local
 * integrations.
 */
export async function hasHermesHooks(): Promise<boolean> {
  const configPath = path.join(getHermesHome(), 'config.yaml');
  if (!(await fileExists(configPath))) {
    return false;
  }

  const doc = parseDocument(await readFile(configPath, 'utf8'));
  const hooks = doc.get('hooks', true);
  if (!(hooks instanceof YAMLMap)) {
    return false;
  }

  return hooks.items.some(({ value }) => {
    if (!(value instanceof YAMLSeq)) {
      return false;
    }
    return value.items.some((item) => MANAGED_HERMES_COMMANDS.has(getEntryCommand(item)));
  });
}

// =============================================================================
// Standalone Hermes Setup (for combined init)
// =============================================================================

export async function hermesSetup(cwd: string): Promise<HermesSetupResult> {
  const paths = getHermesPaths(cwd);

  const configUpdated = await ensureHermesConfig(
    paths,
    await isPromptHookEnabled(cwd, 'hermes'),
  );

  return { configUpdated };
}

// =============================================================================
// Command Registration
// =============================================================================

export function initHermesCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('init-hermes', 'Initialize Hermes Agent MemoryAnchor hooks')
    .action(async () => {
      const cwd = process.cwd();

      const common = await initPublic(cwd);
      const specific = await hermesSetup(cwd);
      const configPath = getHermesPaths(cwd).configPath;

      if (
        common.gitignoreUpdated ||
        common.anchorFilesCreated ||
        common.agentsCreated ||
        specific.configUpdated
      ) {
        context.logger.info(`Memory anchor initialized and Hermes hooks registered in ${configPath}`);
        context.logger.info(
          'Hermes asks for one-time consent per hook on first run; non-interactive runs need `hooks_auto_accept: true` or `HERMES_ACCEPT_HOOKS=1` to register them.',
        );
      } else {
        context.logger.info(`Memory anchor and Hermes hooks already exist in ${configPath}`);
      }
    });
}