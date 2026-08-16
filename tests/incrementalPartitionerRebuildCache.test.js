import { afterEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { updatePartitionedChartsIncrementally } from
  '../dist/chartBuild/partition/incrementalPartitioner.js';

let tempDir = '';

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

test('missing durable dependency state requests the public full-build fallback', async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-incremental-state-'));
  const anchorDir = path.join(tempDir, '.memoryanchor');
  const chartDir = path.join(anchorDir, 'chart');
  await mkdir(chartDir, { recursive: true });
  await writeFile(path.join(anchorDir, 'index.md'), '# index\n', 'utf8');
  await writeFile(path.join(chartDir, 'chart.md'), '# chart\n', 'utf8');
  await writeFile(
    path.join(anchorDir, 'dirTree.json'),
    `${JSON.stringify({
      directory: '.',
      parent: null,
      children: [],
      hasDirectFiles: false,
      thisDirectoryChars: 100,
      isSplit: false
    })}\n`,
    'utf8'
  );
  await writeFile(path.join(tempDir, 'first.ts'), 'export const first = 1;\n', 'utf8');

  await expect(updatePartitionedChartsIncrementally(['first.ts'], {
    projectRoot: tempDir,
    thresholds: { splitAt: 150, mergeAt: 50 }
  })).resolves.toBe(false);
});
