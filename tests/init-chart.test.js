import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  // New grouped format: directory heading + basename
  expect(normalizedChart).toContain('### tests/test-src/');
  for (const { file } of fixtures) {
    expect(normalizedChart).toContain(`- ${file}:`);
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

test('buildChartFull ignores build directories at any depth', async () => {
  const ignoredDirs = [
    path.join(tempDir, 'build'),
    path.join(tempDir, 'packages', 'foo', 'build'),
    path.join(tempDir, 'src', 'build')
  ];
  for (const dir of ignoredDirs) {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'ignored.ts'),
      'export function shouldBeHidden() {}\n'
    );
  }

  await buildChartFull();

  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  expect(normalizedChart).not.toContain('build/ignored.ts');
  expect(normalizedChart).not.toContain('packages/foo/build/ignored.ts');
  expect(normalizedChart).not.toContain('src/build/ignored.ts');
  expect(normalizedChart).not.toContain('shouldBeHidden');
});

test('updateChartIncrementally skips files inside build directories', async () => {
  await buildChartFull();

  const ignored = [
    'build/ignored.ts',
    'packages/foo/build/ignored.ts',
    'src/build/ignored.ts'
  ];
  const realFile = 'tests/test-src/real.ts';
  for (const rel of ignored) {
    const abs = path.join(tempDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, 'export function shouldBeHidden() {}\n');
  }
  await writeFile(
    path.join(tempDir, realFile),
    'export function shouldShow() {}\n'
  );

  await updateChartIncrementally([...ignored, realFile]);

  const chartContent = await readFile(chartPath, 'utf8');
  const normalizedChart = chartContent.replace(/\\/g, '/');

  for (const rel of ignored) {
    expect(normalizedChart).not.toContain(`### /${rel}`);
    expect(normalizedChart).not.toContain(`- /${rel}:`);
  }
  expect(normalizedChart).not.toContain('shouldBeHidden');

  const registryRaw = await readFile(registryPath, 'utf8');
  const registry = JSON.parse(registryRaw);
  for (const rel of ignored) {
    expect(registry[rel]).toBeUndefined();
  }
});
