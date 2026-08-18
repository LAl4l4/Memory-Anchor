import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

import { HOOK_COMMANDS } from '../../dist/constant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitHermes(cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, 'init-hermes'],
      { cwd, env: { ...process.env, HERMES_HOME: path.join(cwd, 'hermes-home') } },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

async function readHermesConfig(cwd) {
  return parseDocument(
    await readFile(path.join(cwd, 'hermes-home', 'config.yaml'), 'utf8'),
  );
}

function listCommands(doc, eventName) {
  const list = doc.getIn(['hooks', eventName]);
  if (!list) return [];
  return list.items.map((item) => item.toJSON());
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-hermes-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('registers context, stop, and session-end hooks in $HERMES_HOME/config.yaml', async () => {
  await runInitHermes(tempDir);

  expect(listCommands(await readHermesConfig(tempDir), 'pre_llm_call')).toEqual([
    { command: HOOK_COMMANDS.HERMES_PRE, timeout: 5 },
  ]);
  expect(listCommands(await readHermesConfig(tempDir), 'on_session_end')).toEqual([
    { command: HOOK_COMMANDS.HERMES_STOP, timeout: 10 },
  ]);
  expect(listCommands(await readHermesConfig(tempDir), 'on_session_finalize')).toEqual([
    { command: HOOK_COMMANDS.HERMES_POST, timeout: 10 },
  ]);
});

test('does not register a prompt hook by default', async () => {
  await runInitHermes(tempDir);

  const doc = await readHermesConfig(tempDir);
  expect(doc.getIn(['hooks', 'pre_llm_call']).items).toHaveLength(1);
});

test('registers the prompt hook when Hermes is enabled in prompt-hooks.json', async () => {
  await mkdir(path.join(tempDir, '.memoryanchor'), { recursive: true });
  await writeFile(
    path.join(tempDir, '.memoryanchor', 'prompt-hooks.json'),
    JSON.stringify({ enabled: ['hermes'] }) + '\n',
  );
  await runInitHermes(tempDir);

  expect(listCommands(await readHermesConfig(tempDir), 'pre_llm_call')).toEqual([
    { command: HOOK_COMMANDS.HERMES_PRE, timeout: 5 },
    { command: HOOK_COMMANDS.HERMES_PROMPT, timeout: 5 },
  ]);
});

test('preserves existing config keys, comments, and user hooks', async () => {
  const hermesHome = path.join(tempDir, 'hermes-home');
  await mkdir(hermesHome, { recursive: true });
  await writeFile(
    path.join(hermesHome, 'config.yaml'),
    [
      '# My custom hermes settings',
      'model:',
      '  default: "anthropic/claude-sonnet-4"',
      '',
      'hooks:',
      '  pre_tool_call:',
      '    - matcher: "terminal"',
      '      command: "~/my-hooks/block-rm.sh"',
      '      timeout: 5',
      '',
    ].join('\n'),
  );

  await runInitHermes(tempDir);

  const doc = await readHermesConfig(tempDir);
  expect(doc.getIn(['model', 'default'])).toBe('anthropic/claude-sonnet-4');
  expect(doc.getIn(['hooks', 'pre_tool_call']).items).toHaveLength(1);
  expect(doc.getIn(['hooks', 'pre_llm_call']).items).toHaveLength(1);
  expect(doc.toString()).toContain('# My custom hermes settings');
});

test('re-running does not duplicate hooks', async () => {
  await runInitHermes(tempDir);
  await runInitHermes(tempDir);

  const doc = await readHermesConfig(tempDir);
  expect(doc.getIn(['hooks', 'pre_llm_call']).items).toHaveLength(1);
  expect(doc.getIn(['hooks', 'on_session_end']).items).toHaveLength(1);
  expect(doc.getIn(['hooks', 'on_session_finalize']).items).toHaveLength(1);
});

test('throws on an invalid existing config instead of corrupting it', async () => {
  const hermesHome = path.join(tempDir, 'hermes-home');
  await mkdir(hermesHome, { recursive: true });
  await writeFile(path.join(hermesHome, 'config.yaml'), 'hooks: [unclosed\n');

  await expect(runInitHermes(tempDir)).rejects.toThrow(/Cannot edit invalid Hermes config/);

  expect(await readFile(path.join(hermesHome, 'config.yaml'), 'utf8')).toBe(
    'hooks: [unclosed\n',
  );
});