import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { getHookProtocol, isValidEventName } from '../../dist/commands/initHelper/hookProtocol.js';

const run = promisify(execFile);
const cli = path.resolve('dist/cli.js');
let root: string;
let home: string;
let workspace: string;
const files = {
  qwencode: '.qwen/settings.json',
  deepseek: '.memoryanchor/deepseek/hooks.json',
  zcode: '../home/.zcode/cli/config.json',
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anchor-native-')));
  home = path.join(root, 'home');
  workspace = path.join(root, 'workspace with spaces');
  await mkdir(workspace);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function command(cwd: string, ...args: string[]) {
  return run(process.execPath, [cli, ...args], {
    cwd, env: { ...process.env, HOME: home, HERMES_HOME: path.join(home, 'hermes') }, timeout: 20000,
  });
}
async function put(file: string, value: unknown) {
  const target = path.resolve(workspace, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
async function read(file: string) { return JSON.parse(await readFile(path.resolve(workspace, file), 'utf8')); }

test.each(['qwencode', 'deepseek', 'zcode'] as const)('%s init preserves user hooks, is idempotent, and installs only supported events', async agent => {
  const user = { hooks: [{ type: 'command', command: 'user-hook', timeout: 42 }] };
  const events = { SessionStart: [user] };
  await put(files[agent], { extra: 'keep', hooks: agent === 'zcode' ? { enabled: false, events } : events });
  await command(workspace, `init-${agent}`);
  const config = await read(files[agent]);
  const hooks = agent === 'zcode' ? config.hooks.events : config.hooks;
  expect(config.extra).toBe('keep');
  expect(hooks.SessionStart[0]).toEqual(user);
  expect(hooks.SessionStart).toHaveLength(2);
  expect(hooks.UserPromptSubmit).toBeUndefined();
  expect(hooks.SessionEnd !== undefined).toBe(agent === 'qwencode');
  expect(Object.keys(hooks).every(event => isValidEventName(agent, event))).toBe(true);
  expect(getHookProtocol(agent).injectionMechanism).toBe('stdout-json-protocol');
  if (agent === 'zcode') {
    expect(config.hooks.enabled).toBe(false);
    expect(hooks.Stop[0].hooks[0]).toMatchObject({ type: 'process', args: [], timeoutMs: 120000 });
    expect((await read('.zcode/config.json')).hooks).toBeUndefined();
  }
  const before = await readFile(path.resolve(workspace, files[agent]), 'utf8');
  await command(workspace, `init-${agent}`);
  expect(await readFile(path.resolve(workspace, files[agent]), 'utf8')).toBe(before);
}, 30000);

test.each(['qwencode', 'deepseek', 'zcode'] as const)('%s rejects invalid configuration without overwriting it', async agent => {
  await put(files[agent], '{broken');
  await expect(command(workspace, `init-${agent}`)).rejects.toThrow();
  expect(await readFile(path.resolve(workspace, files[agent]), 'utf8')).toBe('{broken');
});

test.each(['qwencode', 'deepseek'] as const)('%s prompt opt-in removes only the managed command', async agent => {
  await command(workspace, `init-${agent}`);
  await command(workspace, 'prompt-hook', agent);
  const config = await read(files[agent]);
  config.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: 'keep-me' });
  await put(files[agent], config);
  await command(workspace, 'prompt-hook', '--off', agent);
  expect((await read(files[agent])).hooks.UserPromptSubmit[0].hooks).toEqual([{ type: 'command', command: 'keep-me' }]);
});

test('ZCode keeps global dispatch for another opted-in workspace', async () => {
  await command(workspace, 'init-zcode');
  await command(workspace, 'prompt-hook', 'zcode');
  const another = path.join(root, 'another');
  await mkdir(another);
  await command(another, 'init-zcode');
  await command(another, 'prompt-hook', '--off', 'zcode');
  expect((await read(files.zcode)).hooks.events.UserPromptSubmit[0].hooks[0].command).toBe('memoryanchor-zcode-prompt');
  expect((await read('.memoryanchor/prompt-hooks.json')).enabled).toContain('zcode');
});

test('selecting another agent does not activate unrelated global ZCode hooks', async () => {
  const original = '{"hooks":{"enabled":false,"events":{}},"model":"keep"}';
  await put(files.zcode, original);
  await command(workspace, 'prompt-hook', 'qwencode');
  expect(await readFile(path.resolve(workspace, files.zcode), 'utf8')).toBe(original);
});

test('DeepSeek creates a loadable patch with absolute paths and preserves custom YAML', async () => {
  const patch = '.memoryanchor/deepseek/cordis.patch.yml';
  await put(patch, '# user comment\n- insert:\n    - id: user-plugin\n      name: user-plugin\n');
  const result = await command(workspace, 'init-deepseek');
  const content = await readFile(path.join(workspace, patch), 'utf8');
  expect(content).toContain('# user comment');
  const rows = parseDocument(content).toJS().flatMap((value: any) => value.insert);
  expect(rows.map((value: any) => value.id)).toEqual(['user-plugin', 'memory-anchor-hooks', 'memory-anchor-mcp']);
  expect(rows[1]).toMatchObject({ name: '@deepseek-ai/dsh-hooks-codex', config: { configPath: path.join(workspace, files.deepseek) } });
  expect(rows[2].config).toMatchObject({ serverName: 'memory-anchor', transport: 'stdio', cwd: workspace });
  expect(rows[2].config.args).toContain(workspace);
  expect(result.stdout).toContain('--patch');
  await command(workspace, 'init-deepseek');
  expect(await readFile(path.join(workspace, patch), 'utf8')).toBe(content);
});
