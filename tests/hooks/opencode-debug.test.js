import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-opencode-debug-'));
  const anchorDir = path.join(tempDir, '.memoryanchor');
  await mkdir(anchorDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(anchorDir, 'debug.json'), '{\n  "enabled": true\n}\n'),
    writeFile(path.join(anchorDir, 'index.md'), '# test index\n'),
  ]);
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('OpenCode records transform-hook execution with its resolved workspace', async () => {
  const { MemoryAnchorPlugin } = await import(
    '../../dist/hooks/opencode/memory-anchor-plugin.js'
  );
  const plugin = await MemoryAnchorPlugin({
    directory: tempDir,
    $: () => ({ quiet: async () => {} }),
  });
  const output = { system: [] };

  await plugin['experimental.chat.system.transform']({}, output);

  expect(output.system).toHaveLength(1);
  const log = await readFile(path.join(tempDir, '.memoryanchor', 'debug.log'), 'utf8');
  expect(log).toContain(
    `Hook triggered | agent=opencode | event=experimental.chat.system.transform | workdir=${tempDir}`,
  );
  expect(log).toContain(
    `Hook result | agent=opencode | event=experimental.chat.system.transform | workdir=${tempDir} | status=success | result=memory context injected`,
  );
});
