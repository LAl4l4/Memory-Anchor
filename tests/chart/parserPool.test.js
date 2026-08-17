import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  createBuildChartTestContext,
  repoRoot,
  runChildNode,
  pathToFileURL,
} from './buildChartTestSupport.js';

const context = createBuildChartTestContext();

beforeAll(async () => {
  await context.setup();
});

beforeEach(async () => {
  await context.reset();
});

afterAll(async () => {
  await context.teardown();
});

test('ParserWorkerPool queues the full batch while lazily bounding workers', async () => {
  const localPool = new context.ParserWorkerPool();
  try {
    await localPool.init(3);
    expect(localPool.activeWorkerCount).toBe(0);

    const requests = Array.from({ length: 40 }, (_, index) => ({
      absolutePath: path.join(context.tempDir, 'tests', 'chart', 'test-src', 'sample.ts'),
      relativePath: `tests/chart/test-src/sample-${index}.ts`,
      lang: 'typescript'
    }));
    const parsed = Promise.all(requests.map(request => localPool.parse(
      request.absolutePath,
      request.relativePath,
      request.lang
    )));

    expect(localPool.activeWorkerCount).toBe(3);
    expect(localPool.peakOutstandingTaskCount).toBe(40);

    await expect(parsed).resolves.toHaveLength(40);
    expect(localPool.activeWorkerCount).toBe(3);
    expect(localPool.peakOutstandingTaskCount).toBe(40);
  } finally {
    await localPool.destroy();
  }
});

test('parser workers ignore an inherited --input-type flag', async () => {
  const parserPath = pathToFileURL(
    path.join(repoRoot, 'dist', 'chartBuild', 'parse', 'ASTParser.js'),
  ).href;
  const samplePath = path.join(context.tempDir, 'tests', 'chart', 'test-src', 'sample.ts');
  const childScript = [
    `import { batchParseFiles, destroyPool } from ${JSON.stringify(parserPath)};`,
    `const files = Array.from({ length: 32 }, (_, index) => ({ absolutePath: ${JSON.stringify(samplePath)}, relativePath: \`tests/chart/test-src/sample-\${index}.ts\` }));`,
    'let exitCode = 0;',
    'try {',
    '  const parsed = await batchParseFiles(files);',
    '  if (parsed.length !== files.length) exitCode = 1;',
    '} catch (error) {',
    '  console.error(error);',
    '  exitCode = 1;',
    '} finally {',
    '  await destroyPool();',
    '}',
    'process.exitCode = exitCode;',
  ].join('\n');

  await expect(runChildNode(['--input-type=module', '-e', childScript])).resolves.toEqual(
    expect.objectContaining({ stderr: '' }),
  );
});

test('chart parse cache reuses symbols without reading the file twice', async () => {
  const relativePath = 'tests/chart/test-src/sample.ts';
  const groups = new Map([['tests/chart/test-src', [relativePath]]]);
  const parseCache = new Map();
  const first = await context.buildChartContent(groups, context.tempDir, parseCache);
  await rm(path.join(context.tempDir, relativePath));

  const second = await context.buildChartContent(groups, context.tempDir, parseCache);

  expect(parseCache).toHaveProperty('size', 1);
  expect(second).toBe(first);
});

test('buildChartContent renders its requested heading directly', async () => {
  const relativePath = 'tests/chart/test-src/sample.ts';
  const groups = new Map([['tests/chart/test-src', [relativePath]]]);

  const chart = await context.buildChartContent(
    groups,
    context.tempDir,
    new Map(),
    'CHART AT .memoryanchor/chart/tests/chart/test-src/chart.md',
  );

  expect(chart).toMatch(/^# CHART AT \.memoryanchor\/chart\/tests\/chart\/test-src\/chart\.md\n/);
});
