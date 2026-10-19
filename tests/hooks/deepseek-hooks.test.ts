import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const dist = path.resolve('dist');
const agent = 'deepseek';
let root: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'anchor-deepseek-hooks-'));
  workspace = path.join(root, 'project with spaces');
  await mkdir(path.join(workspace, '.memoryanchor'), { recursive: true });
  await writeFile(path.join(workspace, '.memoryanchor/guardrails.md'), '- [ ] Keep this workspace isolated.\n');
  await writeFile(path.join(workspace, '.memoryanchor/debug.json'), '{"enabled":true}');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function hook(agent: string, file: string, payload: unknown) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(dist, 'hooks', agent, `${file}.js`)],
      { cwd: root, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    child.stdin!.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('deepseek emits complete JSON from the payload workspace and diagnostics have correct identity', async () => {
  const decisions = 'Long decision '.repeat(15000).trim();
  await writeFile(path.join(workspace, '.memoryanchor/decisions.md'), decisions);
  const result = await hook(agent, 'session-start', { cwd: workspace, hook_event_name: 'SessionStart' });
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  expect(output.hookEventName).toBe('SessionStart');
  expect(output.additionalContext).toContain('Keep this workspace isolated.');
  expect(output.additionalContext.includes(decisions)).toBe(true);
  const debug = await readFile(path.join(workspace, '.memoryanchor/debug.log'), 'utf8');
  expect(debug).toContain(`agent=${agent}`);
  expect(debug).toContain('event=SessionStart');
});

test('deepseek prompt is workspace opt-in and outside hooks are silent', async () => {
  expect((await hook(agent, 'user-prompt', { cwd: workspace })).stdout).toBe('');
  await writeFile(path.join(workspace, '.memoryanchor/prompt-hooks.json'), JSON.stringify({ enabled: [agent] }));
  const output = JSON.parse((await hook(agent, 'user-prompt', { cwd: workspace, prompt: 'unchanged' })).stdout);
  expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('get_chart') });
  expect(output.prompt).toBeUndefined();
  for (const event of ['session-start', 'user-prompt', 'stop']) {
    expect(await hook(agent, event, { cwd: root })).toEqual({ stdout: '', stderr: '' });
  }
});

test('deepseek malformed input fails without leaking context', async () => {
  await expect(hook(agent, 'session-start', '{bad')).rejects.toMatchObject({ stdout: '', stderr: expect.stringContaining('Memory Anchor') });
});

test('deepseek Stop refreshes a changed chart and exits', async () => {
  await run('git', ['init', '-q'], { cwd: workspace });
  await writeFile(path.join(workspace, 'demo.ts'), 'export function before() {}\n');
  await run(process.execPath, [path.join(dist, 'cli.js'), 'init-public'], { cwd: workspace, timeout: 15000 });
  await writeFile(path.join(workspace, 'demo.ts'), 'export function afterChange() {}\n');
  await hook(agent, 'stop', { cwd: workspace });
  expect(await readFile(path.join(workspace, '.memoryanchor/chart/chart.md'), 'utf8')).toContain('afterChange');
  expect(await readFile(path.join(workspace, '.memoryanchor/debug.log'), 'utf8')).toContain(`agent=${agent} | event=Stop`);
});
