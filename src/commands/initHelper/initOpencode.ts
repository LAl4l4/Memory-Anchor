import { CAC } from 'cac';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { CommandContext } from '../../types.js';
import { HOOK_COMMANDS, OPENCODE_SCHEMA_URL, REQUIRED_INSTRUCTION_ENTRIES } from '../../constant.js';
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
// The plugin body below hardcodes opencode event names (it has to — the
// generated .js file must be self-contained, it can't import our dist).
// To prevent the next "session.start"-class drift, assert at module load
// that the hardcoded strings still match HOOK_PROTOCOLS.opencode. If a
// future edit to the protocol forgets to update the template (or vice
// versa), this throws and the init command fails fast instead of silently
// shipping a broken plugin.

const OPENCODE_PROTOCOL = HOOK_PROTOCOLS.opencode;
const PROTOCOL_EVENT_NAMES: Set<string> = new Set(
  (
    [
      OPENCODE_PROTOCOL.eventNames.pre,
      OPENCODE_PROTOCOL.eventNames.stop,
      OPENCODE_PROTOCOL.eventNames.post,
      OPENCODE_PROTOCOL.contextInjectionEvent,
    ] as Array<string | null>
  ).filter((v): v is string => v !== null),
);

function assertTemplateEventNamesMatchProtocol(template: string): void {
  const required = (
    [
      OPENCODE_PROTOCOL.contextInjectionEvent,
      OPENCODE_PROTOCOL.eventNames.stop,
      OPENCODE_PROTOCOL.eventNames.post,
    ] as Array<string | null>
  ).filter((v): v is string => v !== null);

  for (const evt of required) {
    if (!template.includes(`"${evt}"`)) {
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
  const matches = template.matchAll(/"((?:[a-z][a-z0-9_]*)(?:\.[a-z][a-z0-9_]*)+)"/g);
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
      `initOpencode: plugin template references event(s) ${JSON.stringify([...seenUnknown])} ` +
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
// OpenCode Plugin Template
// =============================================================================
//
// This file is copied to `<cwd>/.opencode/plugins/memory-anchor.js` and is
// auto-loaded by opencode at startup. It does two distinct jobs:
//
//   1. Context injection — the "${""}experimental.chat.system.transform"
//      hook is the only documented way for a plugin to extend opencode's
//      system prompt. On every LLM turn it reads ./.memoryanchor/ballast.md
//      and ./.memoryanchor/manifest.md from disk (cheap; 2 small files) and
//      pushes the memory-core payload into output.system. This replaces the
//      previous "session.start → fire-and-forget pre hook" design, which
//      never worked: (a) opencode has no "session.start" event, (b) hooks
//      return values through their `output` argument, not via subprocess
//      stdout, and (c) fire-and-forget discards any result anyway.
//
//   2. Side-effect hooks — "session.idle" (work finished) and
//      "session.deleted" trigger the published memoryanchor-opencode-stop /
//      -post CLI bins via ctx.$. These genuinely ARE fire-and-forget because
//      we only need the side effect (incremental chart refresh / session-end
//      bookkeeping); their stdout is intentionally discarded. The `$` comes
//      from the PluginInput ctx (opencode's own BunShell), not from a bare
//      "import { $ } from 'bun'" — the latter isn't part of the plugin
//      contract.

const OPENCODE_PLUGIN_BODY = `// Auto-generated by Memory Anchor. Do not edit by hand.
import * as fs from "node:fs";
import * as path from "node:path";

const ANCHOR_DIR = path.join(process.cwd(), ".memoryanchor");
const BALLAST_PATH = path.join(ANCHOR_DIR, "ballast.md");
const MANIFEST_PATH = path.join(ANCHOR_DIR, "manifest.md");

const HOOK_BIN = "${HOOK_COMMANDS.OPENCODE}";

function readFileSafe(p, fallback) {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim() : fallback;
  } catch {
    return fallback;
  }
}

function buildMemoryCore() {
  const ballastStr = readFileSafe(BALLAST_PATH, "No active coding constraints or lessons-learned enforced.");
  const manifest = readFileSafe(MANIFEST_PATH, "No active cross-session tasks found.");

  const hasStaleRules = ballastStr.includes("[STALE]");
  const taskSection = hasStaleRules
    ? "\\n[TRIGGERED MISSION: MEMORY PRUNING]\\n- Urgent Status: Some developer-enforced limits inside the [2. BALLAST RULES] section are currently flagged with '[STALE]'.\\n- Your Action Required: These rules are likely obsolete due to recent code changes. You MUST evaluate and directly rewrite '.memoryanchor/ballast.md' to DELETE any invalid stale rules during this session.\\n"
    : "";

  return [
    "==================================================",
    "[MEMORY ANCHOR: CONTEXT INJECTED]",
    "Target: Assist the developer by ensuring all generated code aligns with local repository constraints.",
    "",
    taskSection,
    "[1. BALLAST (rules must follow)]",
    ballastStr,
    "",
    "[2. MANIFEST (module status & key decisions)]",
    manifest,
    "==================================================",
  ].join("\\n");
}

export const MemoryAnchorPlugin = async ({ $ }) => {
  return {
    // Inject ballast + manifest into the system prompt on every LLM turn.
    // This is the only documented plugin hook that can extend system context.
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        output.system.push(buildMemoryCore());
      } catch {
        // Swallow — must never break the agent loop.
      }
    },

    // Session idle (work finished) → fire-and-forget incremental chart refresh.
    // We only need the side effect; stdout is intentionally discarded.
    "session.idle": async () => {
      try {
        await $\`\${HOOK_BIN}-stop\`.quiet();
      } catch {
        // Swallow — hooks should never break the agent loop.
      }
    },

    // Session deleted (closed/reset) → fire-and-forget session-end bookkeeping.
    "session.deleted": async () => {
      try {
        await $\`\${HOOK_BIN}-post\`.quiet();
      } catch {
        // Swallow — hooks should never break the agent loop.
      }
    },
  };
};
`;

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
//   - If the plugin file doesn't exist → write the current template.
//   - If the file exists and its content is exactly the current template →
//     leave it alone.
//   - Otherwise (any difference — v1, stale v2, empty, corrupted, or
//     manually edited) → overwrite with the canonical template.

// Validate the template before we ever write it to disk. This runs once
// per process (the const initializer is hoisted) but throws eagerly if
// the template drifted from HOOK_PROTOCOLS.opencode.
assertTemplateEventNamesMatchProtocol(OPENCODE_PLUGIN_BODY);

async function ensurePluginFile(paths: OpencodePaths): Promise<boolean> {
  await mkdir(paths.pluginsDir, { recursive: true });

  const exists = await fileExists(paths.pluginPath);
  if (exists) {
    try {
      const current = await readFile(paths.pluginPath, 'utf8');
      if (current === OPENCODE_PLUGIN_BODY) {
        return false;
      }
    } catch {
      // Can't read → overwrite to guarantee a working plugin.
    }
  }

  await writeFile(paths.pluginPath, OPENCODE_PLUGIN_BODY, 'utf8');
  return true;
}

// =============================================================================
// opencode.json
// =============================================================================
//
// We only manage two keys we own:
//   - `$schema`: pinned for editor autocomplete
//   - `instructions`: prepended with our anchor files (AGENTS.md + memory core)
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
