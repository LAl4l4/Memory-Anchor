import { CAC } from 'cac';
import path from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CommandContext } from '../../types.js';
import { OPENCODE_SCHEMA_URL, REQUIRED_INSTRUCTION_ENTRIES } from '../../constant.js';
import {
  type BasePaths,
  getBasePaths,
  initPublic,
  fileExists,
  readJsonFile,
  writeJsonFile,
} from './initPublic.js';
import { HOOK_PROTOCOLS } from './hookProtocol.js';

// =============================================================================
// Single-source-of-truth sanity check
// =============================================================================
//
// The standalone OpenCode plugin is authored as TypeScript, compiled with the
// rest of this package, then copied verbatim by this initializer. Verify its
// emitted event names against the registry before copying it so a future
// protocol/template mismatch fails loudly instead of silently shipping a
// broken plugin.

const OPENCODE_PROTOCOL = HOOK_PROTOCOLS.opencode;
const PROTOCOL_EVENT_NAMES: Set<string> = new Set(
  (
    [
      OPENCODE_PROTOCOL.eventNames.pre,
      OPENCODE_PROTOCOL.eventNames.prompt,
      OPENCODE_PROTOCOL.eventNames.stop,
      OPENCODE_PROTOCOL.eventNames.post,
      OPENCODE_PROTOCOL.contextInjectionEvent,
      OPENCODE_PROTOCOL.eventNames.prompt,
    ] as Array<string | null>
  ).filter((v): v is string => v !== null),
);

function assertPluginEventNamesMatchProtocol(plugin: string): void {
  const required = (
    [
      OPENCODE_PROTOCOL.contextInjectionEvent,
      OPENCODE_PROTOCOL.eventNames.stop,
      OPENCODE_PROTOCOL.eventNames.post,
    ] as Array<string | null>
  ).filter((v): v is string => v !== null);

  for (const evt of required) {
    if (!plugin.includes(`"${evt}"`) && !plugin.includes(`'${evt}'`)) {
      throw new Error(
        `initOpencode: plugin template lost the "${evt}" event declared in HOOK_PROTOCOLS.opencode. ` +
          `Update the template to use it, or update the protocol — they must stay in sync.`,
      );
    }
  }

  // Anything that looks like `"<prefix>.<name>(.<name>)"`, where prefix is one
  // of the opencode event namespaces, MUST be one of the protocol events.
  // This white-lists the event namespaces we recognize so that `"ballast.md"`,
  // `"memoryanchor-opencode"`, etc. aren't mis-flagged as events.
  const OPENCODE_EVENT_PREFIXES = new Set(['session', 'chat', 'tool', 'shell', 'permission', 'command', 'experimental']);
  const seenUnknown = new Set<string>();
  const matches = plugin.matchAll(/["']((?:[a-z][a-z0-9_]*)(?:\.[a-z][a-z0-9_]*)+)["']/g);
  for (const m of matches) {
    const candidate = m[1];
    const prefix = candidate.split('.')[0];
    if (!OPENCODE_EVENT_PREFIXES.has(prefix)) {
      continue;
    }
    if (PROTOCOL_EVENT_NAMES.has(candidate)) {
      continue;
    }
    seenUnknown.add(candidate);
  }
  if (seenUnknown.size > 0) {
    throw new Error(
      `initOpencode: compiled plugin references event(s) ${JSON.stringify([...seenUnknown])} ` +
        `which are not in HOOK_PROTOCOLS.opencode.`,
    );
  }
}

// =============================================================================
// OpenCode-Specific Types
// =============================================================================

interface OpencodeConfig {
  $schema?: string;
  instructions?: string[];
  plugin?: string[];
  [key: string]: unknown;
}

interface OpencodePaths extends BasePaths {
  opencodeDir: string;
  pluginsDir: string;
  pluginPath: string;
  opencodeConfigPath: string;
}

export interface OpencodeSetupResult {
  pluginWritten: boolean;
  configUpdated: boolean;
}

// =============================================================================
// Compiled OpenCode Plugin
// =============================================================================
//
// This file is copied to `<cwd>/.opencode/plugins/memory-anchor.js` and is
// auto-loaded by opencode at startup. It does three distinct jobs:
//
//   1. Context injection — the "${""}experimental.chat.system.transform"
//      hook is the only documented way for a plugin to extend opencode's
//      system prompt. On every LLM turn it always reads index.md as routing
//      rules, additionally includes ./.memoryanchor/chart/chart.md when that
//      root chart exists, then reads ballast.md and manifest.md from disk and
//      pushes the memory-core payload into output.system. This replaces the
//      previous "session.start → fire-and-forget pre hook" design, which
//      never worked: (a) opencode has no "session.start" event, (b) hooks
//      return values through their `output` argument, not via subprocess
//      stdout, and (c) fire-and-forget discards any result anyway.
//
//   2. Per-message reminder — the stable "chat.message" hook appends the
//      Memory Anchor reminder as the final user-message part. OpenCode has
//      no documented block decision for this hook, so it must be non-blocking.
//
//   3. Side-effect hooks — "session.idle" (work finished) and
//      "session.deleted" trigger the published memoryanchor-opencode-stop /
//      -post CLI bins via ctx.$. These genuinely ARE fire-and-forget because
//      we only need the side effect (incremental chart refresh / session-end
//      bookkeeping); their stdout is intentionally discarded. The `$` comes
//      from the PluginInput ctx (opencode's own BunShell), not from a bare
//      "import { $ } from 'bun'" — the latter isn't part of the plugin
//      contract.

const COMPILED_PLUGIN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hooks/opencode/memory-anchor-plugin.js',
);

// =============================================================================
// OpenCode Paths
// =============================================================================

function getOpencodePaths(cwd: string): OpencodePaths {
  const base = getBasePaths(cwd);
  const opencodeDir = path.join(cwd, '.opencode');
  const pluginsDir = path.join(opencodeDir, 'plugins');

  return {
    ...base,
    opencodeDir,
    pluginsDir,
    pluginPath: path.join(pluginsDir, 'memory-anchor.js'),
    opencodeConfigPath: path.join(cwd, 'opencode.json'),
  };
}

// =============================================================================
// Plugin File (.opencode/plugins/memory-anchor.js)
// =============================================================================
//
// Strategy:
//   - If the plugin file doesn't exist → copy the compiled plugin.
//   - If the file exists and its content is exactly the compiled plugin →
//     leave it alone.
//   - Otherwise (any difference — v1, stale v2, empty, corrupted, or
//     manually edited) → overwrite with the canonical compiled plugin.

async function loadCompiledPlugin(): Promise<string> {
  const plugin = await readFile(COMPILED_PLUGIN_PATH, 'utf8');
  assertPluginEventNamesMatchProtocol(plugin);
  return plugin;
}

async function ensurePluginFile(paths: OpencodePaths): Promise<boolean> {
  await mkdir(paths.pluginsDir, { recursive: true });
  const compiledPlugin = await loadCompiledPlugin();

  const exists = await fileExists(paths.pluginPath);
  if (exists) {
    try {
      const current = await readFile(paths.pluginPath, 'utf8');
      if (current === compiledPlugin) {
        return false;
      }
    } catch {
      // Can't read → overwrite to guarantee a working plugin.
    }
  }

  await copyFile(COMPILED_PLUGIN_PATH, paths.pluginPath);
  return true;
}

// =============================================================================
// opencode.json
// =============================================================================
//
// We only manage two keys we own:
//   - `$schema`: pinned for editor autocomplete
//   - `instructions`: prepended with AGENTS.md; the plugin injects all memory files
// Other keys (model, provider, mcp, …) are left untouched / merged.

async function ensureOpencodeConfig(paths: OpencodePaths): Promise<boolean> {
  const exists = await fileExists(paths.opencodeConfigPath);
  if (!exists) {
    const config: OpencodeConfig = {
      $schema: OPENCODE_SCHEMA_URL,
      instructions: [...REQUIRED_INSTRUCTION_ENTRIES],
    };
    await writeJsonFile(paths.opencodeConfigPath, config);
    return true;
  }

  const config = await readJsonFile<OpencodeConfig>(paths.opencodeConfigPath);
  const updated = mergeOpencodeConfig(config);

  if (updated) {
    await writeJsonFile(paths.opencodeConfigPath, config);
  }

  return updated;
}

function mergeOpencodeConfig(config: OpencodeConfig): boolean {
  let updated = false;

  if (config.$schema == null) {
    config.$schema = OPENCODE_SCHEMA_URL;
    updated = true;
  }

  if (!Array.isArray(config.instructions)) {
    config.instructions = [];
    updated = true;
  }

  // Older versions listed chart.md/index.md separately. The index is now part of the unified
  // plugin payload, so remove the managed legacy entry to avoid duplication.
  const originalInstructionCount = config.instructions!.length;
  config.instructions = config.instructions!.filter(
    (entry) => !['.memoryanchor/chart.md', '.memoryanchor/index.md'].includes(entry.replace(/^\.\//, '')),
  );
  if (config.instructions.length !== originalInstructionCount) {
    updated = true;
  }

  // Prepend our required entries, skipping ones already present (substring
  // match so "./AGENTS.md" matches "AGENTS.md" and vice-versa).
  for (const entry of REQUIRED_INSTRUCTION_ENTRIES) {
    const alreadyPresent = config.instructions!.some(
      (existing) =>
        existing === entry ||
        existing.endsWith(entry.replace(/^\.\//, '')) ||
        entry.endsWith(existing.replace(/^\.\//, '')),
    );
    if (!alreadyPresent) {
      config.instructions!.unshift(entry);
      updated = true;
    }
  }

  return updated;
}

// =============================================================================
// Standalone OpenCode Setup
// =============================================================================

export async function opencodeSetup(cwd: string): Promise<OpencodeSetupResult> {
  const paths = getOpencodePaths(cwd);

  const pluginWritten = await ensurePluginFile(paths);
  const configUpdated = await ensureOpencodeConfig(paths);

  return { pluginWritten, configUpdated };
}

// =============================================================================
// Command Registration
// =============================================================================

export function initOpencodeCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('init-opencode', 'Initialize OpenCode MemoryAnchor workspace')
    .action(async () => {
      const cwd = process.cwd();

      const common = await initPublic(cwd);
      const specific = await opencodeSetup(cwd);

      if (
        common.gitignoreUpdated ||
        common.anchorFilesCreated ||
        common.agentsCreated ||
        specific.pluginWritten ||
        specific.configUpdated
      ) {
        context.logger.info(
          'Memory anchor initialized for OpenCode in ./.memoryanchor and ./.opencode',
        );
      } else {
        context.logger.info(
          'Memory anchor for OpenCode already exists in ./.memoryanchor and ./.opencode',
        );
      }
    });
}
