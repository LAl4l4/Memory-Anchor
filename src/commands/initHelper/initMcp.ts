import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getHermesHome } from './hermesPaths.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parseDocument, YAMLMap } from 'yaml';
import type { PromptHookAgent } from '../../constant.js';
import { logger } from '../../utils/logger.js';
import { asObject, readConfig, readOptional as readOptionalText, saveConfig } from './jsonConfig.js';
import { addDeepseekEntry } from './deepseekPatch.js';
import { MCP_TOOL_NAMES } from '../../mcp/instructions.js';

const SERVER_NAME = 'memory-anchor';
type Config = Record<string, unknown>;

function object(value: unknown, label: string): Config {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cannot register MCP: ${label} must be an object.`);
  }
  return value as Config;
}

async function readOptional(file: string): Promise<string> {
  try { return await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Pin the installed executable, not whichever anchor happens to be on PATH. */
export function getMcpLaunch(workspace?: string): { command: string; args: string[] } {
  const cli = fileURLToPath(new URL('../../cli.js', import.meta.url));
  return { command: process.execPath, args: [cli, 'mcp',
    ...(workspace === undefined ? [] : ['--workspace', path.resolve(workspace)])] };
}

type Launch = { command: string; args: string[] };
/** `tools` lists older init versions wrote (the second still names the removed get_project_state); any other list is a user choice and is kept. */
const LEGACY_TOOL_LISTS = [['get_chart', 'get_file'], ['get_chart', 'get_file', 'get_project_state', 'get_memory', 'write_memory']];

/** An init-written launch runs `<node> <...>/dist/cli.js mcp ...`; any other launch belongs to the user. */
export function isManagedLaunch(argv: unknown[]): boolean {
  return argv.every(part => typeof part === 'string') && argv.some((part, index) => index > 0 &&
    path.basename(part as string) === 'cli.js' && path.basename(path.dirname(part as string)) === 'dist' &&
    argv[index + 1] === 'mcp');
}

const argvOf = (entry: Config): unknown[] => Array.isArray(entry.command)
  ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const canonical = (part: unknown): unknown => {
  if (typeof part !== 'string' || !path.isAbsolute(part)) return part;
  try { return realpathSync(part); } catch { return part; }
};
/** Symlinked spellings of the same node, cli.js or workspace (e.g. /var vs /private/var) are not a change. */
const sameLaunch = (argv: unknown[], launch: Launch): boolean =>
  same(argv.map(canonical), [launch.command, ...launch.args].map(canonical));

/** Point a managed entry at the running installation, keeping every other key (enabled, env, trust). */
function refreshLaunch(existing: Config, launch: Launch): Config | null {
  if (!isManagedLaunch(argvOf(existing))) return null;
  const current = sameLaunch(argvOf(existing), launch);
  if (Array.isArray(existing.command)) return current ? existing : { ...existing, command: [launch.command, ...launch.args] };
  const next: Config = current ? { ...existing } : { ...existing, command: launch.command, args: launch.args };
  if (Array.isArray(existing.tools) && LEGACY_TOOL_LISTS.some(list => same(list, existing.tools))) next.tools = [...MCP_TOOL_NAMES];
  return next;
}

/** Add the entry, refresh a managed one, or keep a user-owned one; returns whether `servers` changed. */
function upsertServer(servers: Config, file: string, fresh: Config, launch: Launch): boolean {
  if (!Object.prototype.hasOwnProperty.call(servers, SERVER_NAME)) { servers[SERVER_NAME] = fresh; return true; }
  const existing = object(servers[SERVER_NAME], `${file}: ${SERVER_NAME}`);
  const next = refreshLaunch(existing, launch);
  if (!next) {
    logger.info(`MCP ${SERVER_NAME} in ${file} uses a custom launch; preserving it.`);
    return false;
  }
  if (same(next, existing)) return false;
  servers[SERVER_NAME] = next;
  return true;
}

async function registerJson(file: string, workspace: string, opencode: boolean): Promise<boolean> {
  const content = await readOptional(file);
  let config = object(content.trim() ? JSON.parse(content) : {}, file);
  // Copilot also accepts a bare server map. Normalize it without dropping servers
  // when sharing this file with clients that require the mcpServers wrapper.
  if (!opencode && config.mcpServers === undefined && Object.keys(config).length > 0 &&
      Object.values(config).every(value => value !== null && typeof value === 'object' &&
        !Array.isArray(value) && ('command' in value || 'url' in value))) {
    config = { mcpServers: config };
  }
  const key = opencode ? 'mcp' : 'mcpServers';
  const servers = object(config[key] === undefined ? {} : config[key], `${file}: ${key}`);
  const launch = getMcpLaunch(workspace);
  const fresh = opencode
    ? { type: 'local', command: [launch.command, ...launch.args], enabled: true }
    : { type: 'stdio', ...launch, tools: [...MCP_TOOL_NAMES] };
  if (!upsertServer(servers, file, fresh, launch)) return false;
  config[key] = servers;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return true;
}

/**
 * Rewrite only the `command` and `args` lines of the server table so comments and other keys survive.
 * Returns null for layouts it cannot edit safely (inline tables, dotted keys, multi-line arrays).
 */
function rewriteCodexLaunch(content: string, launch: Launch): string | null {
  const lines = content.split('\n');
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:"memory-anchor"|'memory-anchor'|memory-anchor)\s*\]\s*(?:#.*)?\r?$/;
  const start = lines.findIndex(line => header.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  for (const [key, value] of Object.entries(launch)) {
    const at = lines.findIndex((line, index) => index > start && index < end && new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (at < 0) return null;
    lines[at] = stringifyToml({ [key]: value }).trim() + (lines[at].endsWith('\r') ? '\r' : '');
  }
  const next = lines.join('\n');
  try {
    const server = (parseToml(next).mcp_servers as Config | undefined)?.[SERVER_NAME] as Config | undefined;
    return server && server.command === launch.command && same(server.args, launch.args) ? next : null;
  } catch { return null; }
}

async function registerCodex(file: string, workspace: string): Promise<boolean> {
  const content = await readOptional(file);
  const parsed = parseToml(content);
  const servers = object(parsed.mcp_servers ?? {}, `${file}: mcp_servers`);
  const launch = getMcpLaunch(workspace);
  if (Object.prototype.hasOwnProperty.call(servers, SERVER_NAME)) {
    const existing = object(servers[SERVER_NAME], `${file}: ${SERVER_NAME}`);
    if (!isManagedLaunch(argvOf(existing))) {
      logger.info(`MCP ${SERVER_NAME} in ${file} uses a custom launch; preserving it.`);
      return false;
    }
    if (sameLaunch(argvOf(existing), launch)) return false;
    const next = rewriteCodexLaunch(content, launch);
    if (next === null) {
      logger.warn(`Cannot refresh ${SERVER_NAME} in ${file} automatically; set command = ${JSON.stringify(launch.command)} and args = ${JSON.stringify(launch.args)}.`);
      return false;
    }
    await writeFile(file, next, 'utf8');
    return true;
  }
  const addition = stringifyToml({ mcp_servers: { [SERVER_NAME]: launch } });
  const next = `${content}${content.endsWith('\n') || !content ? '' : '\n'}\n# Memory Anchor MCP\n${addition}`;
  // Validate the complete document before writing; inline tables cannot be extended.
  parseToml(next);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, 'utf8');
  return true;
}

async function registerHermes(file: string): Promise<boolean> {
  const doc = parseDocument(await readOptional(file));
  if (doc.errors.length) throw new Error(`Cannot edit invalid Hermes config ${file}: ${doc.errors[0].message}`);
  if (doc.contents !== null && !(doc.contents instanceof YAMLMap)) {
    throw new Error(`Cannot register MCP: ${file} must contain a YAML mapping.`);
  }
  const existing = doc.get('mcp_servers', true);
  if (existing !== undefined && !(existing instanceof YAMLMap)) {
    throw new Error(`Cannot register MCP: ${file}: mcp_servers must be a mapping.`);
  }
  const servers = existing instanceof YAMLMap ? existing : new YAMLMap();
  // Global config must not bind every Hermes session to the last initialized repo.
  const launch = getMcpLaunch();
  if (servers.has(SERVER_NAME)) {
    const node = servers.get(SERVER_NAME, true);
    if (!(node instanceof YAMLMap)) throw new Error(`Cannot register MCP: ${file}: ${SERVER_NAME} must be a mapping.`);
    const current = object(node.toJSON(), `${file}: ${SERVER_NAME}`);
    if (!isManagedLaunch(argvOf(current))) {
      logger.info(`MCP ${SERVER_NAME} in ${file} uses a custom launch; preserving it.`);
      return false;
    }
    if (sameLaunch(argvOf(current), launch)) return false;
    // Set values on the existing map so comments and other keys stay in place.
    node.set('command', launch.command);
    node.set('args', doc.createNode(launch.args));
    await writeFile(file, doc.toString(), 'utf8');
    return true;
  }
  servers.set(SERVER_NAME, doc.createNode(launch));
  doc.set('mcp_servers', servers);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, doc.toString(), 'utf8');
  return true;
}

/** Called only by init commands, never by opt-in reminder reconciliation. */
export async function registerMcp(cwd: string, agent: PromptHookAgent): Promise<boolean> {
  let updated: boolean;
  let file: string;
  if (agent === 'deepseek') {
    const launch = getMcpLaunch(cwd);
    const config = { serverName: SERVER_NAME, transport: 'stdio', ...launch, cwd: path.resolve(cwd) };
    return addDeepseekEntry(cwd, { id: 'memory-anchor-mcp', name: '@deepseek-ai/dsh-mcp-client', config }, existing => {
      const current = existing.config !== null && typeof existing.config === 'object' && !Array.isArray(existing.config)
        ? existing.config as Config : {};
      if (!isManagedLaunch(argvOf(current))) return null;
      if (sameLaunch(argvOf(current), launch) && canonical(current.cwd) === canonical(config.cwd)) return existing;
      return { ...existing, config: { ...current, ...config } };
    });
  } else if (agent === 'qwencode') {
    file = path.join(cwd, '.qwen/settings.json');
    const config = await readConfig(file);
    const servers = asObject(config.mcpServers ?? {}, 'mcpServers');
    const launch = getMcpLaunch(cwd);
    if (!upsertServer(servers, file, launch, launch)) return false;
    config.mcpServers = servers;
    updated = await saveConfig(file, config);
  } else if (agent === 'zcode') {
    file = path.join(cwd, '.zcode/config.json');
    const config = await readConfig(file);
    const mcp = asObject(config.mcp ?? {}, 'mcp');
    const servers = asObject(mcp.servers ?? {}, 'mcp.servers');
    const launch = getMcpLaunch(cwd);
    if (!upsertServer(servers, file, launch, launch)) return false;
    mcp.servers = servers;
    config.mcp = mcp;
    updated = await saveConfig(file, config);
  } else if (agent === 'antigravity') {
    const pluginDir = path.join(cwd, '.agents', 'plugins', SERVER_NAME);
    const pluginFile = path.join(pluginDir, 'plugin.json');
    file = path.join(pluginDir, 'mcp_config.json');
    const existingPluginText = await readOptionalText(pluginFile);
    if (existingPluginText.trim()) {
      await readConfig(pluginFile);
    }
    const config = await readConfig(file);
    const servers = asObject(config.mcpServers ?? {}, 'mcpServers');
    const pluginUpdated = existingPluginText.trim()
      ? false
      : await saveConfig(pluginFile, {
          name: SERVER_NAME,
          description: 'Memory Anchor MCP tools for repository architecture charts, file symbols, and project memory.',
        });
    const launch = getMcpLaunch(cwd);
    if (!upsertServer(servers, file, launch, launch)) return pluginUpdated;
    config.mcpServers = servers;
    updated = (await saveConfig(file, config)) || pluginUpdated;
  } else if (agent === 'codex') {
    file = path.join(cwd, '.codex', 'config.toml');
    updated = await registerCodex(file, cwd);
  } else if (agent === 'hermes') {
    file = path.join(getHermesHome(), 'config.yaml');
    updated = await registerHermes(file);
  } else {
    file = path.join(cwd, agent === 'opencode' ? 'opencode.json' : '.mcp.json');
    updated = await registerJson(file, cwd, agent === 'opencode');
  }
  if (updated) logger.info(`Registered or refreshed ${SERVER_NAME} MCP for ${agent} in ${file}. Reload the client to discover its tools.`);
  return updated;
}
