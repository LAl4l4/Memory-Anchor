import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createBuildChartTestContext,
  expectedExports,
  getNodeBlock,
  incrementalRelPaths,
} from './buildChartTestSupport.ts';

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

test('updateChartIncrementally preserves fixture architecture nodes', async () => {
  await context.buildChartFull();
  await context.updateChartIncrementally(incrementalRelPaths);

  const chartContent = await readFile(context.chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const relPath of incrementalRelPaths) {
    expect(getNodeBlock(normalizedChart, relPath)).not.toBeNull();
  }

  for (const [relPath, expectedLines] of expectedExports.entries()) {
    const nodeBlock = getNodeBlock(normalizedChart, relPath);
    expect(nodeBlock).not.toBeNull();

    for (const expectedLine of expectedLines) {
      expect(nodeBlock).toContain(expectedLine);
    }
  }

  const registryRaw = await readFile(context.registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);
  expect(registry.directory).toBe('.');
  expect(registry.thisDirectoryChars).toBeGreaterThan(0);
});

test('updateChartIncrementally edits the matching partition and updates chars', async () => {
  await context.buildChartFull();
  const registryBefore = JSON.parse(await readFile(context.registryPath, 'utf8'));
  const changedFile = path.join(context.tempDir, 'tests', 'chart', 'test-src', 'sample.ts');
  await writeFile(
    changedFile,
    'export function add(a: number, b: number): number { return a + b; }\n' +
      'export function newlyAdded(): string { return "new"; }\n'
  );

  await context.updateChartIncrementally(['tests/chart/test-src/sample.ts']);

  const chartContent = await readFile(context.chartPath, 'utf8');
  const registryAfter = JSON.parse(await readFile(context.registryPath, 'utf8'));
  expect(chartContent).toContain('+ newlyAdded(): string');
  expect(registryAfter.thisDirectoryChars).toBeGreaterThan(
    registryBefore.thisDirectoryChars
  );
});

test('updateChartIncrementally removes a deleted file from its partition', async () => {
  await context.buildChartFull();
  const deletedRelativePath = 'tests/chart/test-src/sample.js';
  await rm(path.join(context.tempDir, deletedRelativePath));

  await context.updateChartIncrementally([deletedRelativePath]);

  const chartContent = await readFile(context.chartPath, 'utf8');
  expect(chartContent).not.toContain('- sample.js:');
  expect(getNodeBlock(chartContent, deletedRelativePath)).toBeNull();
});

test('buildChartFull ignores build directories at any depth', async () => {
  const ignoredDirs = [
    path.join(context.tempDir, 'build'),
    path.join(context.tempDir, 'packages', 'foo', 'build'),
    path.join(context.tempDir, 'src', 'build')
  ];
  for (const dir of ignoredDirs) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'ignored.ts'),
      'export function shouldBeHidden() {}\n'
    );
  }

  await context.buildChartFull();

  const chartContent = await readFile(context.chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  expect(normalizedChart).not.toContain('build/ignored.ts');
  expect(normalizedChart).not.toContain('packages/foo/build/ignored.ts');
  expect(normalizedChart).not.toContain('src/build/ignored.ts');
  expect(normalizedChart).not.toContain('shouldBeHidden');
});

test('updateChartIncrementally skips files inside build directories', async () => {
  await context.buildChartFull();

  const ignored = [
    'build/ignored.ts',
    'packages/foo/build/ignored.ts',
    'src/build/ignored.ts'
  ];
  const realFile = 'tests/chart/test-src/real.ts';
  for (const rel of ignored) {
    const abs = path.join(context.tempDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, 'export function shouldBeHidden() {}\n');
  }
  await writeFile(
    path.join(context.tempDir, realFile),
    'export function shouldShow() {}\n'
  );

  await context.updateChartIncrementally([...ignored, realFile]);

  const chartContent = await readFile(context.chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const rel of ignored) {
    expect(getNodeBlock(normalizedChart, rel)).toBeNull();
    expect(normalizedChart).not.toContain(`- /${rel}:`);
  }
  expect(normalizedChart).not.toContain('shouldBeHidden');

  const registryRaw = await readFile(context.registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);
  expect(registry.directory).toBe('.');
});
