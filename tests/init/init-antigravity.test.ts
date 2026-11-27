import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOOK_COMMANDS } from '../../dist/constant.js';
import { getHookProtocol, isValidEventName } from '../../dist/commands/initHelper/hookProtocol.js';

const run = promisify(execFile);
const cli = path.resolve('dist/cli.js');
let root: string;
let home: string;
let workspace: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anchor-antigravity-init-')));
  home = path.join(root, 'home');
  workspace = path.join(root, 'workspace with spaces');
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function command(cwd: string, ...args: string[]) {
  return run(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, HOME: home, HERMES_HOME: path.join(home, 'hermes') },
    timeout: 20000,
  });
}

async function put(file: string, value: unknown) {
  const target = path.resolve(workspace, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}

async function read(file: string) {
  return JSON.parse(await readFile(path.resolve(workspace, file), 'utf8'));
}

test('init-antigravity writes flat lifecycle hooks, preserves user hooks and disabled flag, and is idempotent', async () => {
  const userGroup = {
    PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }],
  };
  const userStartHandler = { type: 'command', command: './my-start.sh', timeout: 15 };
  await put('.agents/hooks.json', {
    'user-linter': userGroup,
    'memory-anchor': {
      enabled: false,
      SessionStart: [userStartHandler],
    },
  });

  await command(workspace, 'init-antigravity');

  const config = await read('.agents/hooks.json');
  expect(config['user-linter']).toEqual(userGroup);
  const group = config['memory-anchor'];
  expect(group.enabled).toBe(false);
  expect(group.SessionStart).toEqual([
    userStartHandler,
    { type: 'command', command: HOOK_COMMANDS.ANTIGRAVITY_PRE, timeout: 10 },
  ]);
  expect(group.Stop).toEqual([
    { type: 'command', command: HOOK_COMMANDS.ANTIGRAVITY_STOP, timeout: 120 },
  ]);
  expect(group.PreInvocation).toBeUndefined();
  expect(group.SessionEnd).toBeUndefined();

  const eventKeys = Object.keys(group).filter((key) => key !== 'enabled');
  expect(eventKeys.every((event) => isValidEventName('antigravity', event))).toBe(true);
  expect(getHookProtocol('antigravity').injectionMechanism).toBe('stdout-json-protocol');
  expect(getHookProtocol('antigravity').hookConfigShape).toBe('named-flat-hook-groups');

  // Antigravity reads AGENTS.md natively; no separate GEMINI.md is written.
  await expect(readFile(path.join(workspace, 'GEMINI.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

  const plugin = await read('.agents/plugins/memory-anchor/plugin.json');
  expect(plugin).toMatchObject({ name: 'memory-anchor' });
  const mcp = await read('.agents/plugins/memory-anchor/mcp_config.json');
  expect(mcp.mcpServers['memory-anchor'].args).toContain(workspace);

  const beforeHooks = await readFile(path.join(workspace, '.agents/hooks.json'), 'utf8');
  const beforePlugin = await readFile(path.join(workspace, '.agents/plugins/memory-anchor/plugin.json'), 'utf8');
  const beforeMcp = await readFile(path.join(workspace, '.agents/plugins/memory-anchor/mcp_config.json'), 'utf8');
  await command(workspace, 'init-antigravity');
  expect(await readFile(path.join(workspace, '.agents/hooks.json'), 'utf8')).toBe(beforeHooks);
  expect(await readFile(path.join(workspace, '.agents/plugins/memory-anchor/plugin.json'), 'utf8')).toBe(beforePlugin);
  expect(await readFile(path.join(workspace, '.agents/plugins/memory-anchor/mcp_config.json'), 'utf8')).toBe(beforeMcp);
}, 30000);

test('init-antigravity rejects invalid hooks.json without overwriting it', async () => {
  await put('.agents/hooks.json', '{broken');
  await expect(command(workspace, 'init-antigravity')).rejects.toThrow();
  expect(await readFile(path.join(workspace, '.agents/hooks.json'), 'utf8')).toBe('{broken');
});

test('init-antigravity preserves custom plugin.json manifest', async () => {
  const customManifest = '{\n  "name": "memory-anchor",\n  "disabled": true\n}\n';
  await put('.agents/plugins/memory-anchor/plugin.json', customManifest);
  await command(workspace, 'init-antigravity');
  expect(await readFile(path.join(workspace, '.agents/plugins/memory-anchor/plugin.json'), 'utf8')).toBe(customManifest);
});

test('prompt-hook toggles PreInvocation via antigravity and agy alias while preserving user handlers', async () => {
  await command(workspace, 'init-antigravity');
  await command(workspace, 'prompt-hook', 'agy');

  const enabledConfig = await read('.agents/hooks.json');
  expect(enabledConfig['memory-anchor'].PreInvocation).toEqual([
    { type: 'command', command: HOOK_COMMANDS.ANTIGRAVITY_PROMPT, timeout: 10 },
  ]);

  enabledConfig['memory-anchor'].PreInvocation.push({ type: 'command', command: './keep-me.sh' });
  await put('.agents/hooks.json', enabledConfig);

  await command(workspace, 'prompt-hook', '--off', 'antigravity');
  const disabledConfig = await read('.agents/hooks.json');
  expect(disabledConfig['memory-anchor'].PreInvocation).toEqual([
    { type: 'command', command: './keep-me.sh' },
  ]);
});
