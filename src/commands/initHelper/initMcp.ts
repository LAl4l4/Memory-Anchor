import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getHermesHome } from './hermesPaths.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parseDocument, YAMLMap } from 'yaml';
import type { PromptHookAgent } from '../../constant.js';
import { logger } from '../../utils/logger.js';

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

function keepExisting(servers: Config, file: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(servers, SERVER_NAME)) return false;
  object(servers[SERVER_NAME], `${file}: ${SERVER_NAME}`);
  logger.info(`MCP ${SERVER_NAME} already configured in ${file}; preserving its command and settings.`);
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
  if (keepExisting(servers, file)) return false;
  const launch = getMcpLaunch(workspace);
  servers[SERVER_NAME] = opencode
    ? { type: 'local', command: [launch.command, ...launch.args], enabled: true }
    : { type: 'stdio', ...launch, tools: ['get_chart', 'get_file'] };
  config[key] = servers;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return true;
}

async function registerCodex(file: string, workspace: string): Promise<boolean> {
  const content = await readOptional(file);
  const parsed = parseToml(content);
  const servers = object(parsed.mcp_servers ?? {}, `${file}: mcp_servers`);
  if (keepExisting(servers, file)) return false;
  const addition = stringifyToml({ mcp_servers: { [SERVER_NAME]: getMcpLaunch(workspace) } });
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
  if (servers.has(SERVER_NAME)) {
    keepExisting({ [SERVER_NAME]: servers.get(SERVER_NAME) }, file);
    return false;
  }
  // Global config must not bind every Hermes session to the last initialized repo.
  servers.set(SERVER_NAME, doc.createNode(getMcpLaunch()));
  doc.set('mcp_servers', servers);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, doc.toString(), 'utf8');
  return true;
}

/** Called only by init commands, never by opt-in reminder reconciliation. */
export async function registerMcp(cwd: string, agent: PromptHookAgent): Promise<boolean> {
  let updated: boolean;
  let file: string;
  if (agent === 'codex') {
    file = path.join(cwd, '.codex', 'config.toml');
    updated = await registerCodex(file, cwd);
  } else if (agent === 'hermes') {
    file = path.join(getHermesHome(), 'config.yaml');
    updated = await registerHermes(file);
  } else {
    file = path.join(cwd, agent === 'opencode' ? 'opencode.json' : '.mcp.json');
    updated = await registerJson(file, cwd, agent === 'opencode');
  }
  if (updated) logger.info(`Registered ${SERVER_NAME} MCP for ${agent} in ${file}. Reload the client to discover its tools.`);
  return updated;
}
