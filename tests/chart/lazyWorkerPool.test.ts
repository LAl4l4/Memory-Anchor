import { expect, test } from '@jest/globals';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

import { LazyWorkerPool } from '../../dist/chartBuild/shared/lazyWorkerPool.js';
import { pathToFileURL, repoRoot, runChildNode } from './buildChartTestSupport.ts';

test('destroy terminates a worker that is still starting', async () => {
  let startingWorker: Worker | undefined;
  const pool = new LazyWorkerPool({
    createWorker: () => {
      startingWorker = new Worker('setInterval(() => {}, 1_000)', { eval: true });
      return startingWorker;
    },
    getResult: message => message,
    getError: message => new Error(String(message)),
  });

  await pool.init(1);
  const taskResult = pool.submit({ value: 1 }).catch(error => error);

  expect(pool.activeWorkerCount).toBe(1);
  await pool.destroy();

  await expect(taskResult).resolves.toThrow('Worker pool destroyed');
  expect(pool.activeWorkerCount).toBe(0);
  if (!startingWorker) throw new Error('Expected the pool to create a worker');
  expect(startingWorker.threadId).toBe(-1);
});

test('an abandoned idle pool does not keep the process alive', async () => {
  const poolPath = pathToFileURL(
    path.join(repoRoot, 'dist', 'chartBuild', 'shared', 'lazyWorkerPool.js'),
  ).href;
  const workerSource = [
    "import('node:worker_threads').then(({ parentPort }) => {",
    "  parentPort.postMessage({ type: 'ready' });",
    "  parentPort.on('message', message => parentPort.postMessage({ value: message.value }));",
    '});',
  ].join('\n');
  const childScript = [
    "import { Worker } from 'node:worker_threads';",
    `import { LazyWorkerPool } from ${JSON.stringify(poolPath)};`,
    'const pool = new LazyWorkerPool({',
    `  createWorker: () => new Worker(${JSON.stringify(workerSource)}, { eval: true }),`,
    '  getResult: message => message.value,',
    '  getError: message => new Error(String(message)),',
    '});',
    'await pool.init(1);',
    'const result = await pool.submit({ value: 7 });',
    'if (result !== 7) process.exitCode = 1;',
    '// Intentionally omit destroy(): the now-idle worker must not pin the process.',
  ].join('\n');

  await expect(runChildNode(['--input-type=module', '-e', childScript], 2_000)).resolves.toEqual({
    stdout: '',
    stderr: '',
  });
});
