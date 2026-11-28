import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG_PATH = path.join(AGENT_ROOT, 'config.json');
const EXAMPLE_CONFIG_PATH = path.join(AGENT_ROOT, 'config.example.json');

const AGENT_DEFAULTS = {
  engine: 'langgraph',
  maxTurns: 40,
  allowCommands: true,
  commandTimeoutMs: 120_000,
  maxToolOutputChars: 20_000,
  loadAgentsMd: true,
  /** Only for engine langgraph-multi. maxTurns above stays the total across all roles. */
  multiAgent: {
    plannerMaxTurns: 12,
    reviewerMaxTurns: 10,
    maxReviewRounds: 2,
  },
};

const MEMORY_ANCHOR_DEFAULTS = {
  enabled: false,
  root: '',
  sessionStartHook: true,
  promptHook: false,
  mcp: true,
  stopHook: true,
  hookTimeoutMs: 60_000,
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge where `override` wins; arrays and scalars are replaced, not merged. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== '$comment').map(([key, v]) => [key, stripComments(v)]),
  );
}

/**
 * Load the agent config. Resolution order: explicit path → $MA_AGENT_CONFIG → MA-mini-agent/config.json.
 * `overrides` (e.g. from CLI flags) are merged last.
 */
export function loadConfig(configPath, overrides = {}) {
  const resolved = configPath ?? process.env.MA_AGENT_CONFIG ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(resolved)) {
    throw new Error(
      `Config not found: ${resolved}\nCopy ${path.relative(process.cwd(), EXAMPLE_CONFIG_PATH)} to config.json and fill in your model API settings.`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Config ${resolved} is not valid JSON: ${error.message}`);
  }
  const merged = mergeConfig(stripComments(raw), overrides);
  const config = {
    ...merged,
    agent: mergeConfig(AGENT_DEFAULTS, merged.agent),
    memoryAnchor: mergeConfig(MEMORY_ANCHOR_DEFAULTS, merged.memoryAnchor),
    configPath: resolved,
  };
  if (!config.memoryAnchor.root) config.memoryAnchor.root = path.resolve(AGENT_ROOT, '..');
  config.memoryAnchor.root = path.resolve(path.dirname(resolved), config.memoryAnchor.root);
  return config;
}

/** Return the selected provider's settings with the API key resolved. */
export function resolveProviderConfig(config) {
  const name = config.provider;
  if (!name) throw new Error('Config is missing "provider".');
  const settings = config.providers?.[name];
  if (!settings) throw new Error(`Config has no providers.${name} section.`);
  const apiKey = settings.apiKey || (settings.apiKeyEnv ? process.env[settings.apiKeyEnv] : '') || '';
  if (name !== 'mock' && !apiKey) {
    throw new Error(
      `No API key for provider "${name}": set providers.${name}.apiKey in config.json` +
        (settings.apiKeyEnv ? ` or export ${settings.apiKeyEnv}.` : '.'),
    );
  }
  return { name, ...settings, apiKey };
}
