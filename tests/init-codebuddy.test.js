import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitCodebuddy(cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-codebuddy'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-codebuddy-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .codebuddy/settings.json with SessionStart hook', async () => {
  await runInitCodebuddy(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.codebuddy', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionStart).toBeDefined();
  expect(settings.hooks.SessionStart[0].hooks[0].type).toBe('command');
  expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('memoryanchor-codebuddy-pre');
});

test('creates .codebuddy/settings.json with Stop hook', async () => {
  await runInitCodebuddy(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.codebuddy', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.Stop).toBeDefined();
  expect(settings.hooks.Stop[0].hooks[0].command).toBe('memoryanchor-codebuddy-stop');
  // Stop event does not have matcher field
  expect(settings.hooks.Stop[0].matcher).toBeUndefined();
});

test('creates .codebuddy/settings.json with SessionEnd hook', async () => {
  await runInitCodebuddy(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.codebuddy', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionEnd).toBeDefined();
  expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe('memoryanchor-codebuddy-post');
});

test('creates CODEBUDDY.md with memory anchor line', async () => {
  await runInitCodebuddy(tempDir);

  const codebuddyMd = await readFile(path.join(tempDir, 'CODEBUDDY.md'), 'utf8');
  expect(codebuddyMd).toContain('- Follow `AGENTS.md` for Memory Anchor rules.');
});

test('existing CODEBUDDY.md content is preserved', async () => {
  const codebuddyMdPath = path.join(tempDir, 'CODEBUDDY.md');
  await writeFile(codebuddyMdPath, '# My Custom Rules\n\nBe helpful.\n');

  await runInitCodebuddy(tempDir);

  const content = await readFile(codebuddyMdPath, 'utf8');
  expect(content).toContain('# My Custom Rules');
  expect(content).toContain('Be helpful.');
  expect(content).toContain('- Follow `AGENTS.md` for Memory Anchor rules.');
});

test('preserves existing settings.json content when adding hooks', async () => {
  const codebuddyDir = path.join(tempDir, '.codebuddy');
  const settingsPath = path.join(codebuddyDir, 'settings.json');
  await mkdir(codebuddyDir, { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        permissions: { allow: ['Read', 'Glob'] },
        model: 'default',
      },
      null,
      2,
    ) + '\n',
  );

  await runInitCodebuddy(tempDir);

  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  expect(settings.permissions).toBeDefined();
  expect(settings.permissions.allow).toEqual(['Read', 'Glob']);
  expect(settings.model).toBe('default');
  expect(settings.hooks.SessionStart).toBeDefined();
  expect(settings.hooks.Stop).toBeDefined();
  expect(settings.hooks.SessionEnd).toBeDefined();
});

test('re-running does not duplicate hooks', async () => {
  await runInitCodebuddy(tempDir);
  await runInitCodebuddy(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(tempDir, '.codebuddy', 'settings.json'), 'utf8'),
  );
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.SessionEnd).toHaveLength(1);
});

test('re-running does not duplicate CODEBUDDY.md anchor line', async () => {
  await runInitCodebuddy(tempDir);
  await runInitCodebuddy(tempDir);

  const codebuddyMd = await readFile(path.join(tempDir, 'CODEBUDDY.md'), 'utf8');
  const matches = codebuddyMd.match(/Follow `AGENTS\.md` for Memory Anchor rules\./g);
  expect(matches).toHaveLength(1);
});
