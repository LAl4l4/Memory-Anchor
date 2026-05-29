import { afterAll, beforeEach, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildChartFull,
  updateChartIncrementally
} from '../dist/core/build-chart.js';

const projectRoot = process.cwd();
const anchorDir = path.join(projectRoot, '.memoryanchor');
const chartPath = path.join(anchorDir, 'chart.md');
const registryPath = path.join(anchorDir, 'registry.json');
const fixtures = [
  { file: 'sample.c' },
  { file: 'sample.py' },
  { file: 'Sample.java' }
];

const fixtureRelPaths = fixtures.map(({ file }) =>
  path.posix.join('tests', 'test-src', file)
);

async function cleanupAnchor() {
  await fs.rm(anchorDir, { recursive: true, force: true });
}

beforeEach(async () => {
  await cleanupAnchor();
});

/*afterAll(async () => {
  await cleanupAnchor();
});*/

test('buildChartFull includes fixture paths in the skeleton', async () => {
  await buildChartFull();

  const chartContent = await fs.readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const relPath of fixtureRelPaths) {
    expect(normalizedChart).toContain(`- /${relPath}:`);
  }
});

test('updateChartIncrementally adds fixture nodes and registry', async () => {
  await buildChartFull();
  await updateChartIncrementally(fixtureRelPaths);

  const chartContent = await fs.readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const relPath of fixtureRelPaths) {
    expect(normalizedChart).toContain(`### /${relPath}`);
  }

  const registryRaw = await fs.readFile(registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);

  for (const relPath of fixtureRelPaths) {
    expect(registry[relPath]).toBeDefined();
  }
});
