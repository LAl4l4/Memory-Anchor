import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const originalCwd = process.cwd();

let buildChartFull;
let updateChartIncrementally;
let tempDir = '';
let anchorDir = '';
let chartPath = '';
let registryPath = '';

const fixtures = [
  { file: 'sample.c' },
  { file: 'sample.py' },
  { file: 'Sample.java' },
  { file: 'sample.js' },
  { file: 'sample.ts' }
];

const fixtureRelPaths = fixtures.map(({ file }) =>
  path.posix.join('tests', 'test-src', file)
);

const expectedExports = new Map([
  [path.posix.join('tests', 'test-src', 'sample.c'), ['- function add()']],
  [path.posix.join('tests', 'test-src', 'sample.py'), ['- function greet()']],
  [path.posix.join('tests', 'test-src', 'sample.js'), ['- export function add()']],
  [path.posix.join('tests', 'test-src', 'sample.ts'), ['- export function add()']]
]);
const incrementalRelPaths = Array.from(expectedExports.keys());

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
  if (!anchorDir) {
    return;
  }
  await rm(anchorDir, { recursive: true, force: true });
}

async function seedFixtures(baseDir) {
  const fixturesDir = path.join(baseDir, 'tests', 'test-src');
  await mkdir(fixturesDir, { recursive: true });

  for (const { file } of fixtures) {
    const source = path.join(repoRoot, 'tests', 'test-src', file);
    const destination = path.join(fixturesDir, file);
    await copyFile(source, destination);
  }
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-chart-'));
  process.chdir(tempDir);
  await seedFixtures(tempDir);

  ({ buildChartFull, updateChartIncrementally } = await import('../dist/core/build-chart.js'));

  anchorDir = path.join(tempDir, '.memoryanchor');
  chartPath = path.join(anchorDir, 'chart.md');
  registryPath = path.join(anchorDir, 'registry.json');
});

beforeEach(async () => {
  await cleanupAnchor();
});

afterAll(async () => {
  await cleanupAnchor();
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildChartFull includes fixture paths in the skeleton', async () => {
  await buildChartFull();

  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const relPath of fixtureRelPaths) {
    expect(normalizedChart).toContain(`- /${relPath}:`);
  }
});

test('updateChartIncrementally adds fixture nodes and registry', async () => {
  await buildChartFull();
  await updateChartIncrementally(incrementalRelPaths);

  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const relPath of incrementalRelPaths) {
    expect(normalizedChart).toContain(`### /${relPath}`);
  }

  for (const [relPath, expectedLines] of expectedExports.entries()) {
    const nodeBlock = getNodeBlock(normalizedChart, relPath);
    expect(nodeBlock).not.toBeNull();

    for (const expectedLine of expectedLines) {
      expect(nodeBlock).toContain(expectedLine);
    }
  }

  const registryRaw = await readFile(registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);

  for (const relPath of incrementalRelPaths) {
    expect(registry[relPath]).toBeDefined();
  }
});
