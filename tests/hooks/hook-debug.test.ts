import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');

let tempDir = '';

function runHook(relativePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(repoRoot, 'dist', relativePath)],
      { cwd: tempDir },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-hook-debug-'));
  const anchorDir = path.join(tempDir, '.memoryanchor');
  await mkdir(anchorDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(anchorDir, 'index.md'), '# test index\n'),
    writeFile(path.join(anchorDir, 'debug.json'), '{\n  "enabled": true\n}\n'),
  ]);
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('native hooks record their agent, event, workdir, and successful result', async () => {
  const output = await runHook('hooks/claude/session-start.js');
  const workdir = realpathSync(tempDir);

  expect(output).toContain('[MEMORY ANCHOR: CONTEXT INJECTED]');

  const log = await readFile(path.join(tempDir, '.memoryanchor', 'debug.log'), 'utf8');
  expect(log).toContain(
    `Hook triggered | agent=claude | event=SessionStart | workdir=${workdir}`,
  );
  expect(log).toContain(
    `Hook result | agent=claude | event=SessionStart | workdir=${workdir} | status=success | result=memory context injected`,
  );
});

test('hook invocation inference preserves Codex Stop despite its shared session-end handler', async () => {
  const { getHookInvocation } = await import('../../dist/hooks/public/hookDebug.js');

  expect(getHookInvocation('/tmp/dist/hooks/codex/stop.js', '/workspace')).toEqual({
    agent: 'codex',
    event: 'Stop',
    workdir: '/workspace',
  });
});

test('hook invocation inference recognizes installed package-bin names', async () => {
  const { getHookInvocation } = await import('../../dist/hooks/public/hookDebug.js');

  expect(getHookInvocation('/usr/local/bin/memoryanchor-opencode-post', '/workspace')).toEqual({
    agent: 'opencode',
    event: 'session.idle',
    workdir: '/workspace',
  });
});
