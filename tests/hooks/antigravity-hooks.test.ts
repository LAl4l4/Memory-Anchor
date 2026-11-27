import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getHookInvocation } from '../../dist/hooks/public/hookDebug.js';

const run = promisify(execFile);
const dist = path.resolve('dist');
const agent = 'antigravity';
let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'anchor-antigravity-hooks-'));
  workspace = path.join(root, 'project with spaces');
  await mkdir(path.join(workspace, '.memoryanchor'), { recursive: true });
  await writeFile(path.join(workspace, '.memoryanchor/guardrails.md'), '- [ ] Keep this workspace isolated.\n');
  await writeFile(path.join(workspace, '.memoryanchor/debug.json'), '{"enabled":true}');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function hook(file: string, payload: unknown, cwd: string = root) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(dist, 'hooks', agent, `${file}.js`)],
      { cwd, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    child.stdin!.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('antigravity SessionStart emits complete injectSteps systemMessage JSON and diagnostics', async () => {
  const decisions = 'Long decision '.repeat(15000).trim();
  await writeFile(path.join(workspace, '.memoryanchor/decisions.md'), decisions);

  const result = await hook('session-start', {
    conversationId: 'conv-1',
    cwd: workspace,
    workspacePaths: [workspace],
    hookEventName: 'SessionStart',
  });
  const output = JSON.parse(result.stdout);
  expect(output.injectSteps).toHaveLength(1);
  const message = output.injectSteps[0].systemMessage.systemMessage;
  expect(message).toContain('[MEMORY ANCHOR: CONTEXT INJECTED]');
  expect(message).toContain('Keep this workspace isolated.');
  expect(message.includes(decisions)).toBe(true);

  const debug = await readFile(path.join(workspace, '.memoryanchor/debug.log'), 'utf8');
  expect(debug).toContain('agent=antigravity');
  expect(debug).toContain('event=SessionStart');
});

test('antigravity resolves workspace from subdir cwd+workspacePaths, workspacePaths only, and .agents cwd fallback', async () => {
  const subdir = path.join(workspace, 'packages', 'sub');
  const agentsDir = path.join(workspace, '.agents');
  await mkdir(subdir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });

  const fromSubdir = JSON.parse(
    (await hook('session-start', { cwd: subdir, workspacePaths: [workspace] })).stdout,
  );
  expect(fromSubdir.injectSteps[0].systemMessage.systemMessage).toContain('Keep this workspace isolated.');

  const fromWorkspacePathsOnly = JSON.parse(
    (await hook('session-start', { workspacePaths: [root, workspace] })).stdout,
  );
  expect(fromWorkspacePathsOnly.injectSteps[0].systemMessage.systemMessage).toContain('Keep this workspace isolated.');

  const fromAgentsDir = JSON.parse((await hook('session-start', {}, agentsDir)).stdout);
  expect(fromAgentsDir.injectSteps[0].systemMessage.systemMessage).toContain('Keep this workspace isolated.');
});

test('antigravity PreInvocation is workspace opt-in and outside hooks return empty JSON', async () => {
  expect(JSON.parse((await hook('pre-invocation', { cwd: workspace, invocationNum: 1 })).stdout)).toEqual({});

  await writeFile(path.join(workspace, '.memoryanchor/prompt-hooks.json'), JSON.stringify({ enabled: [agent] }));
  const output = JSON.parse(
    (await hook('pre-invocation', { cwd: workspace, invocationNum: 1, lastUserInput: 'hello' })).stdout,
  );
  expect(output.injectSteps).toHaveLength(1);
  expect(output.injectSteps[0].systemMessage.systemMessage).toContain('get_chart');
  expect(await readFile(path.join(workspace, '.memoryanchor/debug.log'), 'utf8')).toContain(
    'agent=antigravity | event=PreInvocation',
  );

  expect(await hook('session-start', { cwd: root })).toEqual({ stdout: '{}', stderr: '' });
  expect(await hook('pre-invocation', { cwd: root })).toEqual({ stdout: '{}', stderr: '' });
  expect(await hook('stop', { cwd: root })).toEqual({ stdout: '{"decision":"allow"}', stderr: '' });
});

test('antigravity malformed input fails without leaking context to stdout', async () => {
  await expect(hook('session-start', '{bad')).rejects.toMatchObject({
    stdout: '',
    stderr: expect.stringContaining('Memory Anchor antigravity SessionStart'),
  });
  await expect(hook('session-start', { cwd: 'relative/path' })).rejects.toMatchObject({
    stdout: '',
    stderr: expect.stringContaining('cwd must be absolute'),
  });
});

test('antigravity Stop refreshes a changed chart, emits allow decision, and exits', async () => {
  await run('git', ['init', '-q'], { cwd: workspace });
  await writeFile(path.join(workspace, 'demo.ts'), 'export function before() {}\n');
  await run(process.execPath, [path.join(dist, 'cli.js'), 'init-public'], { cwd: workspace, timeout: 15000 });
  await writeFile(path.join(workspace, 'demo.ts'), 'export function afterChange() {}\n');

  const result = await hook('stop', {
    cwd: workspace,
    workspacePaths: [workspace],
    terminationReason: 'NO_TOOL_CALL',
    fullyIdle: true,
  });
  expect(JSON.parse(result.stdout)).toEqual({ decision: 'allow' });
  expect(await readFile(path.join(workspace, '.memoryanchor/chart/chart.md'), 'utf8')).toContain('afterChange');
  expect(await readFile(path.join(workspace, '.memoryanchor/debug.log'), 'utf8')).toContain(
    'agent=antigravity | event=Stop',
  );
});

test('hookDebug recognizes Antigravity script and bin names', () => {
  expect(getHookInvocation('/usr/local/bin/memoryanchor-antigravity-pre', '/workspace')).toEqual({
    agent: 'antigravity',
    event: 'SessionStart',
    workdir: '/workspace',
  });
  expect(getHookInvocation('/usr/local/bin/memoryanchor-antigravity-prompt', '/workspace')).toEqual({
    agent: 'antigravity',
    event: 'PreInvocation',
    workdir: '/workspace',
  });
  expect(getHookInvocation('/usr/local/bin/memoryanchor-antigravity-stop', '/workspace')).toEqual({
    agent: 'antigravity',
    event: 'Stop',
    workdir: '/workspace',
  });
});
