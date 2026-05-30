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

const expectedFunctions = new Map([
  [path.posix.join('tests', 'test-src', 'sample.c'), ['add']],
  [path.posix.join('tests', 'test-src', 'sample.py'), ['greet']]
]);
const incrementalRelPaths = Array.from(expectedFunctions.keys());

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNodeBlock(chartContent, relPath) {
  const matcher = new RegExp(
    `### \\/${escapeRegExp(relPath)}\\n([\\s\\S]*?)(?=\\n### \\/|$)`
  );
  const match = chartContent.match(matcher);
  return match ? match[1] : null;
}

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
  await updateChartIncrementally(incrementalRelPaths);

  const chartContent = await fs.readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const relPath of incrementalRelPaths) {
    expect(normalizedChart).toContain(`### /${relPath}`);
  }

  for (const [relPath, functionNames] of expectedFunctions.entries()) {
    const nodeBlock = getNodeBlock(normalizedChart, relPath);
    expect(nodeBlock).not.toBeNull();

    for (const name of functionNames) {
      expect(nodeBlock).toContain(`- function ${name}()`);
    }
  }

  const registryRaw = await fs.readFile(registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);

  for (const relPath of incrementalRelPaths) {
    expect(registry[relPath]).toBeDefined();
  }
});
